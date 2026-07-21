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
#include "devtools/cdp_wire.h"
#include "quickjs.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
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

// RemoteObject for a Console evaluation result. Primitives are full-fidelity;
// objects/functions get a description only (JSON.stringify when it works, so
// `({a:1})` shows as {"a":1} rather than [object Object]) and NO objectId —
// the engine's pause-scoped objectId registry frees ids on resume, so ids
// minted outside a pause would dangle. Expandable console results are a
// follow-up; the value is still visible as text.
static std::string consoleRemoteObjectJSON(JSContext* ctx, JSValueConst v) {
  using rill::devtools::cdp::escapeJSON;
  if (JS_IsUndefined(v)) return R"({"type":"undefined"})";
  if (JS_IsNull(v)) return R"({"type":"object","subtype":"null","value":null})";
  if (JS_IsBool(v))
    return std::string("{\"type\":\"boolean\",\"value\":") +
           (JS_ToBool(ctx, v) ? "true" : "false") + "}";
  if (JS_IsNumber(v)) {
    double d = 0;
    JS_ToFloat64(ctx, &d, v);
    const char* s = JS_ToCString(ctx, v);
    std::ostringstream ss;
    if (std::isfinite(d))
      ss << "{\"type\":\"number\",\"value\":" << (s ? s : "0")
         << ",\"description\":\"" << (s ? s : "0") << "\"}";
    else  // NaN / +-Infinity are not valid JSON numbers
      ss << "{\"type\":\"number\",\"unserializableValue\":\"" << (s ? s : "NaN")
         << "\",\"description\":\"" << (s ? s : "NaN") << "\"}";
    if (s) JS_FreeCString(ctx, s);
    return ss.str();
  }
  if (JS_IsString(v)) {
    const char* s = JS_ToCString(ctx, v);
    std::string out =
        "{\"type\":\"string\",\"value\":\"" + escapeJSON(s ? s : "") + "\"}";
    if (s) JS_FreeCString(ctx, s);
    return out;
  }
  const bool isFn = JS_IsFunction(ctx, v);
  std::string desc;
  if (!isFn) {
    JSValue j = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsString(j)) {
      const char* s = JS_ToCString(ctx, j);
      if (s) desc = s;
      if (s) JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, j);
  }
  if (desc.empty()) {
    const char* s = JS_ToCString(ctx, v);
    if (s) desc = s;
    if (s) JS_FreeCString(ctx, s);
  }
  // Stringify can run throwing toString/toJSON; drain any pending exception so
  // the context stays clean.
  JS_FreeValue(ctx, JS_GetException(ctx));
  if (desc.size() > 4096) desc.resize(4096);  // bound the payload
  if (isFn)
    return "{\"type\":\"function\",\"className\":\"Function\",\"description\":\"" +
           escapeJSON(desc) + "\"}";
  return "{\"type\":\"object\",\"className\":\"Object\",\"description\":\"" +
         escapeJSON(desc) + "\"}";
}

// Evaluate `expr` in global scope on the CURRENT thread and build the complete
// Runtime.evaluate CDP response (result or exceptionDetails). Must run on the
// thread that owns the runtime: the guest thread when idle, or the captive
// paused thread via runOnPausedThread.
static std::string evalConsoleExpression(JSContext* ctx, long id,
                                         const std::string& expr) {
  using rill::devtools::cdp::escapeJSON;
  JSValue v = JS_Eval(ctx, expr.c_str(), expr.size(), "<console>",
                      JS_EVAL_TYPE_GLOBAL);
  std::ostringstream ss;
  if (JS_IsException(v)) {
    JSValue ex = JS_GetException(ctx);
    const char* s = JS_ToCString(ctx, ex);
    const std::string msg = escapeJSON(s ? s : "<exception>");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, JS_GetException(ctx));  // ToCString may itself throw
    ss << "{\"id\":" << id
       << ",\"result\":{\"result\":{\"type\":\"object\",\"subtype\":\"error\","
          "\"description\":\"" << msg << "\"},"
          "\"exceptionDetails\":{\"exceptionId\":1,\"text\":\"Uncaught\","
          "\"lineNumber\":0,\"columnNumber\":0,"
          "\"exception\":{\"type\":\"object\",\"subtype\":\"error\","
          "\"description\":\"" << msg << "\"}}}}";
    JS_FreeValue(ctx, ex);
  } else {
    ss << "{\"id\":" << id << ",\"result\":{\"result\":"
       << consoleRemoteObjectJSON(ctx, v) << "}}";
  }
  JS_FreeValue(ctx, v);
  return ss.str();
}

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

  // Guest runner: registers the script once, then services a job queue on the
  // runtime-owning thread — guest re-runs (runIfWaitingForDebugger) and idle
  // Console evaluations both execute here, so nothing ever touches the runtime
  // from a second thread.
  std::mutex runM;
  std::condition_variable runCv;
  std::deque<std::function<void()>> guestJobs;
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
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> lk(runM);
        runCv.wait(lk, [&] { return !guestJobs.empty() || quit.load(); });
        if (quit.load()) break;
        job = std::move(guestJobs.front());
        guestJobs.pop_front();
      }
      job();
    }
  });
  auto postGuestJob = [&](std::function<void()> job) {
    {
      std::lock_guard<std::mutex> lk(runM);
      guestJobs.push_back(std::move(job));
    }
    runCv.notify_all();
  };

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

  // Reader: each stdin line is a CDP message.
  //  - Debugger.* and Runtime.getProperties go to the target (AdapterDebugTarget's
  //    Runtime branch resolves scope/object expansion against the paused frame;
  //    without forwarding getProperties a real DevTools frontend shows an EMPTY
  //    Scope panel).
  //  - Runtime.enable is acked and answered with executionContextCreated: DevTools
  //    will not send Console input at all until it has seen an execution context.
  //  - Runtime.evaluate (Console input outside a pause; paused-state Console goes
  //    through Debugger.evaluateOnCallFrame) is evaluated on whichever thread owns
  //    the runtime right now: the captive paused thread via runOnPausedThread, or
  //    the idle guest thread via the job queue. Not covered (still gaps):
  //    console.log forwarding (Runtime.consoleAPICalled), expandable object
  //    results, awaitPromise.
  //  - Any other domain (Profiler, Log, ...) is acked with an empty result so the
  //    front-end handshake proceeds, and runIfWaitingForDebugger is the trigger to
  //    (re-)run the guest so freshly-set breakpoints can be hit.
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    if (line.find("\"Debugger.") != std::string::npos ||
        line.find("\"Runtime.getProperties\"") != std::string::npos) {
      target->dispatch(conn, line);
    } else if (line.find("\"Runtime.enable\"") != std::string::npos) {
      long id = extractId(line);
      if (id >= 0) sendLine("{\"id\":" + std::to_string(id) + ",\"result\":{}}");
      sendLine(
          "{\"method\":\"Runtime.executionContextCreated\",\"params\":{"
          "\"context\":{\"id\":1,\"origin\":\"\",\"name\":\"rill-quickjs\","
          "\"uniqueId\":\"rill-quickjs-ctx-1\"}}}");
    } else if (line.find("\"Runtime.evaluate\"") != std::string::npos) {
      long id = extractId(line);
      auto expr = cdp::parseJSONString(line, "expression");
      if (id < 0) continue;
      if (!expr) {
        sendLine("{\"id\":" + std::to_string(id) +
                 ",\"error\":{\"code\":-32602,\"message\":\"missing expression\"}}");
        continue;
      }
      // Paused: evaluate on the captive runtime thread (debug hook suppressed,
      // so the eval cannot self-pause). Global scope is correct for
      // Runtime.evaluate; frame-scoped Console input arrives as
      // Debugger.evaluateOnCallFrame and takes the target path above.
      std::string pausedResp;
      const bool ranPaused = core->runOnPausedThread([&](JSContext* c) {
        pausedResp = evalConsoleExpression(c, id, *expr);
      });
      if (ranPaused) {
        sendLine(pausedResp);
        continue;
      }
      // Not paused: queue onto the guest thread and wait briefly. The timeout
      // covers the one hazard: the guest starts running and traps at a
      // breakpoint before servicing this job — blocking forever here would
      // wedge stdin and make the pause impossible to resume. An abandoned
      // job still runs when the thread next drains the queue, but its
      // response is dropped (DevTools already got the timeout error).
      struct EvalWaiter {
        std::mutex m;
        std::condition_variable cv;
        bool done = false;
        bool abandoned = false;
      };
      auto st = std::make_shared<EvalWaiter>();
      postGuestJob([st, id, expr = *expr, ctx, &sendLine] {
        std::string resp = evalConsoleExpression(ctx, id, expr);
        std::lock_guard<std::mutex> lk(st->m);
        if (!st->abandoned) sendLine(resp);
        st->done = true;
        st->cv.notify_all();
      });
      std::unique_lock<std::mutex> lk(st->m);
      if (!st->cv.wait_for(lk, std::chrono::seconds(3),
                           [&] { return st->done; })) {
        st->abandoned = true;
        sendLine("{\"id\":" + std::to_string(id) +
                 ",\"error\":{\"code\":-32000,\"message\":"
                 "\"evaluate timed out: guest is busy or paused\"}}");
      }
    } else {
      long id = extractId(line);
      if (id >= 0) sendLine("{\"id\":" + std::to_string(id) + ",\"result\":{}}");
      if (line.find("runIfWaitingForDebugger") != std::string::npos) {
        postGuestJob([ctx] {
          JSValue v = JS_Eval(ctx, kGuest, std::strlen(kGuest), "guest.js",
                              JS_EVAL_TYPE_GLOBAL);
          JS_FreeValue(ctx, v);
        });
      }
    }
  }

  // stdin closed: tear down. detach() (not a single resume()) clears the
  // breakpoints and latches the hook off, so a runtime parked at one breakpoint
  // resumes AND does not re-trap on a downstream breakpoint — otherwise the
  // guest would pause again with no reader left to resume it and the join below
  // would block forever.
  quit.store(true);
  core->detach();
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
