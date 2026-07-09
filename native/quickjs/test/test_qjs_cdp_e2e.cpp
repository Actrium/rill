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

  // While paused, evaluate expressions in the (global-scope) paused context.
  // The dispatch runs the eval on the blocked runtime thread and returns once
  // its response has been pushed to the sink.
  target.dispatch(
      1,
      R"({"id":10,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"1+2"}})");
  check(sink.waitFor("\"value\":3,\"description\":\"3\"", "eval 1+2"),
        "evaluateOnCallFrame 1+2 -> number 3");
  target.dispatch(
      1,
      R"({"id":11,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"'a'+'b'"}})");
  check(sink.waitFor("\"type\":\"string\",\"value\":\"ab\"", "eval string"),
        "evaluateOnCallFrame 'a'+'b' -> string \"ab\"");
  // Reads global state: at the line-3 breakpoint, log holds only 'a'.
  target.dispatch(
      1,
      R"({"id":12,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"globalThis.log.length"}})");
  check(sink.waitFor("\"value\":1,\"description\":\"1\"", "eval global read"),
        "evaluateOnCallFrame globalThis.log.length -> 1");
  // A throwing expression is reported as an error and clears the pending
  // exception so the paused program can still resume cleanly.
  target.dispatch(
      1,
      R"json({"id":13,"method":"Debugger.evaluateOnCallFrame","params":{"callFrameId":"0","expression":"nope()"}})json");
  check(sink.waitFor("\"subtype\":\"error\"", "eval throw"),
        "evaluateOnCallFrame nope() -> error object");

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

  // --- Nested stack over CDP: Debugger.paused must carry every call frame. ----
  {
    JSRuntime* nrt = JS_NewRuntime();
    JSContext* nctx = JS_NewContext(nrt);
    QuickJSDebugCore ncore(nrt, nctx);
    auto nEngine =
        std::make_shared<QuickJSEngineDebugger>(&ncore, /*tenantId=*/1);
    auto nAdapter = std::make_shared<DebuggerAdapter>();
    nAdapter->setEngineDebugger(nEngine);
    AdapterDebugTarget nTarget(nAdapter, /*tenantId=*/1);
    nEngine->setPausedNotifier(
        [nAdapter](PauseReason r, const std::vector<CallFrame>& frames,
                   const std::vector<std::string>& hits) {
          nAdapter->onPaused(1, r, frames, hits);
        });

    Sink nsink;
    nTarget.onClientConnect(1, [&nsink](const RawCdpMessage& m) { nsink.push(m); });
    nTarget.dispatch(1, R"({"id":1,"method":"Debugger.enable"})");
    // Breakpoint inside c() at source line 2 (CDP lineNumber 1).
    nTarget.dispatch(
        1,
        R"({"id":2,"method":"Debugger.setBreakpoint","params":{"location":{"scriptId":"stack.js","lineNumber":1}}})");

    std::promise<void> nDone;
    auto nFut = nDone.get_future();
    std::thread nThread([&] {
      JS_UpdateStackTop(nrt);
      static const char* kStack =
          "function c() {\n"          // 1
          "  globalThis.hit = 1;\n"   // 2 <- breakpoint
          "}\n"                        // 3
          "function b() {\n"          // 4
          "  c();\n"                   // 5
          "}\n"                        // 6
          "function a() {\n"          // 7
          "  b();\n"                   // 8
          "}\n"                        // 9
          "a();\n";                    // 10
      JSValue v = JS_Eval(nctx, kStack, std::strlen(kStack), "stack.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(nctx, v);
      nDone.set_value();
    });

    check(nsink.waitFor("\"Debugger.paused\"", "nested paused event"),
          "nested Debugger.paused delivered");
    // The serialized callFrames array carries the innermost c and its callers
    // (functions kept multi-line so QuickJS does not tail-call-eliminate them).
    check(nsink.waitFor("\"functionName\":\"c\"", "frame c"),
          "paused payload includes innermost frame c");
    check(nsink.waitFor("\"functionName\":\"b\"", "frame b"),
          "paused payload includes caller frame b");
    check(nsink.waitFor("\"functionName\":\"a\"", "frame a"),
          "paused payload includes caller frame a");

    nTarget.dispatch(1, R"({"id":3,"method":"Debugger.resume"})");
    check(nFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "nested case resumed to completion");
    nThread.join();

    JS_FreeContext(nctx);
    JS_FreeRuntime(nrt);
  }

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " ("
            << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
