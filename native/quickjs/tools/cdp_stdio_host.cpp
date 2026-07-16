// A long-running CDP host for the QuickJS rill debugger, speaking newline-
// delimited CDP JSON over stdio. A WebSocket bridge (cdp_ws_bridge.js) puts a
// real Chrome DevTools front-end in front of it: ws frame -> stdin line, stdout
// line -> ws frame.
//
// It wires the SAME production stack the e2e drives —
//   AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger ->
//   QuickJSDebugCore -> the patched interpreter — around a small guest script,
// and re-runs that script on Runtime.runIfWaitingForDebugger so breakpoints set
// from the UI take effect on the next run.
//
// Portable C/C++; build with build-cdp-host.sh (RILL_QJS_DEBUG + RILL_WIP_CDP_DEVTOOLS).

#include "QuickJSDebugCore.h"
#include "QuickJSEngineDebugger.h"
#include "devtools/AdapterDebugTarget.h"
#include "devtools/DebuggerAdapter.h"
#include "quickjs.h"

#include <atomic>
#include <condition_variable>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

using namespace rill::devtools;
using rill::qjs_debug::QuickJSDebugCore;
using rill::qjs_debug::QuickJSEngineDebugger;

// The guest program under debug. Line 3 (`var msg = ...`) is a good breakpoint.
static const char* kGuest =
    "function greet(name) {\n"                       // line 1
    "  var count = (globalThis.count || 0) + 1;\n"   // line 2
    "  var msg = 'hello ' + name + ' #' + count;\n"  // line 3  <- try a bp here
    "  globalThis.count = count;\n"                  // line 4
    "  globalThis.last = msg;\n"                      // line 5
    "  return msg;\n"                                 // line 6
    "}\n"                                             // line 7
    "greet('world');\n";                             // line 8

int main() {
  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  auto core = std::make_unique<QuickJSDebugCore>(rt, ctx);
  auto engineDbg = std::make_shared<QuickJSEngineDebugger>(core.get(), /*tenant=*/1);
  auto adapter = std::make_shared<DebuggerAdapter>();
  adapter->setEngineDebugger(engineDbg);
  auto target = std::make_shared<AdapterDebugTarget>(adapter, /*tenant=*/1);

  DebuggerAdapter* adapterRaw = adapter.get();
  engineDbg->setPausedNotifier(
      [adapterRaw](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
        adapterRaw->onPaused(1, r, frames, hits);
      });
  engineDbg->setScriptParsedNotifier(
      [adapterRaw](const ScriptInfo& info) { adapterRaw->onScriptParsed(1, info); });

  // Outbound: one CDP message per line on stdout, flushed so the bridge sees it
  // immediately. Guard stdout against interleaving from multiple threads.
  static std::mutex outM;
  const ConnectionId conn = 1;
  target->onClientConnect(conn, [](const std::string& msg) {
    std::lock_guard<std::mutex> lk(outM);
    std::cout << msg << "\n" << std::flush;
  });

  // Guest runner: registers the script once, then re-runs on request so that
  // breakpoints set by the UI can be hit.
  std::mutex runM;
  std::condition_variable runCv;
  bool runRequested = false;
  std::atomic<bool> quit{false};
  // Latch: the reader must not dispatch any CDP command until the guest has
  // registered its script. Otherwise Debugger.enable replays nothing and a
  // setBreakpointByUrl arriving first resolves to an empty scriptId and never
  // arms — the classic "breakpoint set before the script is known" race.
  std::mutex readyM;
  std::condition_variable readyCv;
  bool scriptReady = false;
  std::thread guestThread([&] {
    JS_UpdateStackTop(rt);  // this thread owns the runtime
    // Register the script (emits scriptParsed; Debugger.enable replays it).
    JSValue v0 = JS_Eval(ctx, kGuest, std::strlen(kGuest), "guest.js",
                         JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, v0);
    {
      std::lock_guard<std::mutex> lk(readyM);
      scriptReady = true;
    }
    readyCv.notify_all();
    for (;;) {
      std::unique_lock<std::mutex> lk(runM);
      runCv.wait(lk, [&] { return runRequested || quit.load(); });
      if (quit.load()) break;
      runRequested = false;
      lk.unlock();
      JSValue v = JS_Eval(ctx, kGuest, std::strlen(kGuest), "guest.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(ctx, v);
    }
  });

  auto sendLine = [](const std::string& s) {
    std::lock_guard<std::mutex> lk(outM);
    std::cout << s << "\n" << std::flush;
  };
  auto extractId = [](const std::string& s) -> long {
    auto p = s.find("\"id\"");
    if (p == std::string::npos) return -1;
    p = s.find(':', p);
    if (p == std::string::npos) return -1;
    return std::strtol(s.c_str() + p + 1, nullptr, 10);
  };

  // Wait until the guest has registered its script before touching stdin, so
  // Debugger.enable can replay scriptParsed and by-URL breakpoints resolve.
  {
    std::unique_lock<std::mutex> lk(readyM);
    readyCv.wait(lk, [&] { return scriptReady; });
  }

  // Reader: each stdin line is a CDP message. The target owns the Debugger domain
  // AND fronts Runtime.getProperties for this single engine — AdapterDebugTarget's
  // Runtime branch resolves scope/object expansion against the paused frame — so
  // forward BOTH to it. Without forwarding Runtime.getProperties a real DevTools
  // frontend shows an EMPTY Scope panel: it expands each scope object via
  // Runtime.getProperties, which would otherwise be swallowed by the empty ack
  // below. Any other domain (Runtime.enable/evaluate, Profiler, Log, ...) is acked
  // with an empty result so the front-end handshake still proceeds, and
  // runIfWaitingForDebugger is the trigger to (re-)run the guest so freshly-set
  // breakpoints can be hit. (Console via Runtime.evaluate needs an execution
  // context and a Runtime.evaluate handler — a separate, larger gap.)
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    if (line.find("\"Debugger.") != std::string::npos ||
        line.find("\"Runtime.getProperties\"") != std::string::npos) {
      target->dispatch(conn, line);
    } else {
      long id = extractId(line);
      if (id >= 0) sendLine("{\"id\":" + std::to_string(id) + ",\"result\":{}}");
      if (line.find("runIfWaitingForDebugger") != std::string::npos) {
        {
          std::lock_guard<std::mutex> lk(runM);
          runRequested = true;
        }
        runCv.notify_all();
      }
    }
  }

  // stdin closed: make sure a paused runtime can exit, then tear down.
  quit.store(true);
  core->resume();
  runCv.notify_all();
  guestThread.join();
  target->onClientDisconnect(conn);
  // Tear down in dependency order: the adapter owns a shared_ptr to the engine
  // debugger, and the engine debugger's destructor clears its callback on the
  // core (core_->setPausedCallback). So the adapter and engine debugger must be
  // destroyed BEFORE the core is freed — otherwise ~QuickJSEngineDebugger runs
  // after core.reset() and touches freed memory.
  target.reset();
  adapter.reset();
  engineDbg.reset();
  core.reset();
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return 0;
}
