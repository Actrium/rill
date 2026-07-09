// Native e2e for the QuickJS engine debug hook (M1: pause / resume / line
// breakpoints). Builds the vendored QuickJS (with the RILL_QJS_DEBUG hook) plus
// QuickJSDebugCore and drives a real runtime:
//   - set a breakpoint on line 3 of a 4-line script;
//   - run JS on a runtime thread; the interpreter blocks at line 3;
//   - the pause is observed from another thread (breakpoint line reported);
//   - the runtime stays blocked until resume();
//   - after resume the script finishes and its side effects are visible.
//
// QuickJS is portable C, so this builds and runs locally — no Hermes/Apple
// toolchain. See build-run.sh.

#include "QuickJSDebugCore.h"
#include "quickjs.h"

#include <atomic>
#include <chrono>
#include <cstring>
#include <future>
#include <iostream>
#include <string>
#include <thread>

using rill::qjs_debug::QuickJSDebugCore;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << "\n";
  if (!ok) ++g_failures;
}

int main() {
  std::cout << "=== QuickJS engine debug-hook e2e ===\n";

  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  QuickJSDebugCore dbg(rt, ctx);

  std::promise<int> firstPause;
  auto pauseFut = firstPause.get_future();
  std::atomic<bool> pauseSet{false};
  dbg.setPausedCallback([&](const std::string&, int line) {
    if (!pauseSet.exchange(true)) firstPause.set_value(line);
  });

  static const char* kCode =
      "globalThis.log = [];\n"   // line 1
      "log.push('a');\n"          // line 2
      "log.push('b');\n"          // line 3  <-- breakpoint
      "globalThis.done = 1;\n";   // line 4
  dbg.addBreakpoint("bp.js", 3);

  std::promise<void> evalDone;
  auto evalFut = evalDone.get_future();
  std::thread runtimeThread([&] {
    // The runtime was created on the main thread but runs here; rebase QuickJS's
    // stack-overflow guard onto this thread's stack. (In the real sandbox the
    // runtime is created and run on the same host thread, so this isn't needed.)
    JS_UpdateStackTop(rt);
    JSValue v =
        JS_Eval(ctx, kCode, std::strlen(kCode), "bp.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
      JSValue e = JS_GetException(ctx);
      const char* msg = JS_ToCString(ctx, e);
      std::cout << "  (eval exception tag=" << JS_VALUE_GET_TAG(e)
                << " msg=" << (msg ? msg : "<null>") << ")\n";
      if (msg) JS_FreeCString(ctx, msg);
      JSValue st = JS_GetPropertyStr(ctx, e, "stack");
      const char* sts = JS_ToCString(ctx, st);
      if (sts) { std::cout << "  (stack: " << sts << ")\n"; JS_FreeCString(ctx, sts); }
      JS_FreeValue(ctx, st);
      JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, v);
    evalDone.set_value();
  });

  int line = pauseFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready
                 ? pauseFut.get()
                 : -1;
  check(line == 3, "breakpoint paused at line 3 (reported " + std::to_string(line) + ")");
  check(dbg.isPaused(), "isPaused() true while the runtime thread is blocked");
  check(evalFut.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready,
        "runtime thread stays blocked while paused");

  dbg.resume();
  bool finished =
      evalFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
  check(finished, "resume unblocked the runtime; eval ran to completion");
  runtimeThread.join();

  // Side effects only exist if line 3 + line 4 ran after resume.
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
