// M2 e2e: drive the QuickJS engine debugger through the FULL CDP relay stack —
// AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger -> QuickJSDebugCore
// -> the patched interpreter — with raw CDP messages, exactly as CDPServer would.
//
//   - Debugger.enable / Debugger.setBreakpoint round-trip through the sink;
//   - a breakpoint on source line 3 (CDP lineNumber 2) pauses the runtime;
//   - the Debugger.paused event arrives out-of-band through the connection sink;
//   - Debugger.resume (dispatched from another thread) unblocks the runtime;
//   - the post-resume side effect is observable.
//
// Portable C/C++, builds locally. See build-run-cdp.sh.

#include "QuickJSDebugCore.h"
#include "QuickJSEngineDebugger.h"
#include "devtools/AdapterDebugTarget.h"
#include "devtools/DebuggerAdapter.h"
#include "quickjs.h"

#include <chrono>
#include <condition_variable>
#include <cstring>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

using namespace rill::devtools;
using rill::qjs_debug::QuickJSDebugCore;
using rill::qjs_debug::QuickJSEngineDebugger;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << "\n";
  if (!ok) ++g_failures;
}

namespace {
struct Sink {
  std::mutex m;
  std::condition_variable cv;
  std::string all;
  void push(const std::string& msg) {
    std::lock_guard<std::mutex> lk(m);
    all += msg;
    all += '\n';
    cv.notify_all();
  }
  bool waitFor(const std::string& needle, const char* label) {
    std::unique_lock<std::mutex> lk(m);
    bool ok = cv.wait_for(lk, std::chrono::seconds(10),
                          [&] { return all.find(needle) != std::string::npos; });
    if (!ok) std::cout << "  (timeout waiting for " << label << ")\n";
    return ok;
  }
};
}  // namespace

int main() {
  std::cout << "=== QuickJS CDP relay e2e (full stack) ===\n";

  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  QuickJSDebugCore core(rt, ctx);

  auto engineDbg = std::make_shared<QuickJSEngineDebugger>(&core, /*tenantId=*/1);
  auto adapter = std::make_shared<DebuggerAdapter>();
  adapter->setEngineDebugger(engineDbg);
  AdapterDebugTarget target(adapter, /*tenantId=*/1);

  // Engine pause -> Debugger.paused event (through the adapter's sink).
  engineDbg->setPausedNotifier(
      [adapter](PauseReason r, const std::vector<CallFrame>& frames,
                const std::vector<std::string>& hits) {
        adapter->onPaused(1, r, frames, hits);
      });

  Sink sink;
  target.onClientConnect(1, [&sink](const RawCdpMessage& m) { sink.push(m); });

  target.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
  check(sink.waitFor("\"id\":1", "enable response"), "Debugger.enable acknowledged");

  target.dispatch(
      1,
      R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"bp.js","lineNumber":2}}})");
  check(sink.waitFor("\"breakpointId\"", "setBreakpoint response"),
        "Debugger.setBreakpoint acknowledged (CDP line 2 = source line 3)");

  std::promise<void> evalDone;
  auto evalFut = evalDone.get_future();
  std::thread runtimeThread([&] {
    JS_UpdateStackTop(rt);  // runtime runs on this thread (see M1 harness note)
    static const char* kCode =
        "globalThis.log = [];\n"   // 1
        "log.push('a');\n"          // 2
        "log.push('b');\n"          // 3 <- breakpoint
        "globalThis.done = 1;\n";   // 4
    JSValue v =
        JS_Eval(ctx, kCode, std::strlen(kCode), "bp.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, v);
    evalDone.set_value();
  });

  check(sink.waitFor("\"Debugger.paused\"", "paused event"),
        "Debugger.paused delivered out-of-band via the connection sink");
  check(evalFut.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready,
        "runtime thread stays blocked while paused");

  target.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
  bool finished =
      evalFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
  check(finished, "Debugger.resume unblocked the runtime; eval completed");
  runtimeThread.join();

  JSValue g = JS_GetGlobalObject(ctx);
  JSValue doneV = JS_GetPropertyStr(ctx, g, "done");
  int32_t done = -1;
  JS_ToInt32(ctx, &done, doneV);
  check(done == 1, "post-resume side effect observed (done === 1)");
  JS_FreeValue(ctx, doneV);
  JS_FreeValue(ctx, g);

  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " ("
            << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
