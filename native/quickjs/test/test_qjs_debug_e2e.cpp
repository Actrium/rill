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
#include <condition_variable>
#include <cstring>
#include <deque>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

using rill::qjs_debug::PauseReason;
using rill::qjs_debug::QuickJSDebugCore;

static int g_failures = 0;
static void check(bool ok, const std::string& what) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << "\n";
  if (!ok) ++g_failures;
}

// Thread-safe queue of pause events, so the driving thread can consume pauses in
// order and issue the next step/resume without racing the runtime thread.
struct PauseBus {
  std::mutex m;
  std::condition_variable cv;
  std::deque<std::pair<int, PauseReason>> events;  // (1-based line, reason)

  void push(int line, PauseReason r) {
    {
      std::lock_guard<std::mutex> lk(m);
      events.emplace_back(line, r);
    }
    cv.notify_all();
  }
  // Next pause within 5s, or (-1, Pause) on timeout.
  std::pair<int, PauseReason> next() {
    std::unique_lock<std::mutex> lk(m);
    if (!cv.wait_for(lk, std::chrono::seconds(5),
                     [&] { return !events.empty(); }))
      return {-1, PauseReason::Pause};
    auto e = events.front();
    events.pop_front();
    return e;
  }
};

int main() {
  std::cout << "=== QuickJS engine debug-hook e2e ===\n";

  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  QuickJSDebugCore dbg(rt, ctx);

  std::promise<int> firstPause;
  auto pauseFut = firstPause.get_future();
  std::atomic<bool> pauseSet{false};
  dbg.setPausedCallback([&](const std::string&, int line, PauseReason) {
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

  // --- Stepping (M3.1): depth-aware step into / over / out. -------------------
  static const char* kStepCode =
      "function foo() {\n"        // line 1
      "  globalThis.x = 1;\n"     // line 2
      "  globalThis.y = 2;\n"     // line 3
      "}\n"                        // line 4
      "globalThis.z = 0;\n"       // line 5  <-- breakpoint (before the call)
      "foo();\n"                   // line 6  (call site)
      "globalThis.z = 9;\n";      // line 7
  {
    JSRuntime* srt = JS_NewRuntime();
    JSContext* sctx = JS_NewContext(srt);
    QuickJSDebugCore sdbg(srt, sctx);
    PauseBus bus;
    sdbg.setPausedCallback(
        [&](const std::string&, int line, PauseReason r) { bus.push(line, r); });
    sdbg.addBreakpoint("step.js", 5);

    std::promise<void> stepDone;
    auto stepFut = stepDone.get_future();
    std::thread stepThread([&] {
      JS_UpdateStackTop(srt);
      JSValue v = JS_Eval(sctx, kStepCode, std::strlen(kStepCode), "step.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(sctx, v);
      stepDone.set_value();
    });

    auto e1 = bus.next();  // breakpoint before the call
    check(e1.first == 5 && e1.second == PauseReason::Breakpoint,
          "breakpoint at line 5 (got line " + std::to_string(e1.first) + ")");

    sdbg.stepOver();
    auto e2 = bus.next();  // advance to the call site, same depth
    check(e2.first == 6 && e2.second == PauseReason::Step,
          "stepOver -> call site line 6 (got line " + std::to_string(e2.first) + ")");

    sdbg.stepInto();
    auto e3 = bus.next();  // descend into foo's body (depth +1)
    check(e3.first == 2 && e3.second == PauseReason::Step,
          "stepInto -> foo body line 2 (got line " + std::to_string(e3.first) + ")");

    sdbg.stepOver();
    auto e4 = bus.next();  // next line at the same (deeper) depth
    check(e4.first == 3 && e4.second == PauseReason::Step,
          "stepOver -> line 3 same depth (got line " + std::to_string(e4.first) + ")");

    sdbg.stepOut();
    auto e5 = bus.next();  // back in the caller (returns to the call-site line)
    check(e5.first == 6 && e5.second == PauseReason::Step,
          "stepOut -> back at caller line 6 (got line " + std::to_string(e5.first) + ")");

    sdbg.resume();
    check(stepFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "resume ran the stepping script to completion");
    stepThread.join();

    JSValue g2 = JS_GetGlobalObject(sctx);
    JSValue zv = JS_GetPropertyStr(sctx, g2, "z");
    int32_t z = -1;
    JS_ToInt32(sctx, &z, zv);
    check(z == 9, "stepping side effects complete (z === 9)");
    JS_FreeValue(sctx, zv);
    JS_FreeValue(sctx, g2);

    JS_FreeContext(sctx);
    JS_FreeRuntime(srt);
  }

  // stepOver must step OVER a call, not descend into it. -----------------------
  {
    JSRuntime* srt = JS_NewRuntime();
    JSContext* sctx = JS_NewContext(srt);
    QuickJSDebugCore sdbg(srt, sctx);
    PauseBus bus;
    sdbg.setPausedCallback(
        [&](const std::string&, int line, PauseReason r) { bus.push(line, r); });
    sdbg.addBreakpoint("step.js", 5);

    std::promise<void> done;
    auto fut = done.get_future();
    std::thread th([&] {
      JS_UpdateStackTop(srt);
      JSValue v = JS_Eval(sctx, kStepCode, std::strlen(kStepCode), "step.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(sctx, v);
      done.set_value();
    });

    auto e1 = bus.next();
    check(e1.first == 5, "stepOver case: paused at line 5");
    sdbg.stepOver();       // line 5 -> call site line 6, same depth
    auto e2 = bus.next();
    check(e2.first == 6, "stepOver case: advanced to call site line 6");
    sdbg.stepOver();       // over foo() — must NOT stop inside foo (lines 2/3)
    auto e3 = bus.next();
    check(e3.first == 7 && e3.second == PauseReason::Step,
          "stepOver skipped the call -> line 7 (got line " +
              std::to_string(e3.first) + ")");
    sdbg.resume();
    check(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "resume completed after stepOver-skip");
    th.join();
    JS_FreeContext(sctx);
    JS_FreeRuntime(srt);
  }

  // --- Real call frames (M3.2): full live stack at a nested breakpoint. -------
  static const char* kStackCode =
      "function c() {\n"          // line 1
      "  globalThis.hit = 1;\n"   // line 2  <-- breakpoint (innermost)
      "}\n"                        // line 3
      "function b() {\n"          // line 4
      "  c();\n"                   // line 5  (calls c)
      "}\n"                        // line 6
      "function a() {\n"          // line 7
      "  b();\n"                   // line 8  (calls b)
      "}\n"                        // line 9
      "a();\n";                    // line 10 (top-level call)
  {
    JSRuntime* frt = JS_NewRuntime();
    JSContext* fctx = JS_NewContext(frt);
    QuickJSDebugCore fdbg(frt, fctx);

    std::vector<QuickJSDebugCore::FrameSnapshot> captured;
    std::promise<void> reached;
    auto reachedFut = reached.get_future();
    std::atomic<bool> once{false};
    // Capture on the runtime thread, while paused and the chain is intact.
    fdbg.setPausedCallback([&](const std::string&, int, PauseReason) {
      if (!once.exchange(true)) {
        captured = fdbg.captureFrames();
        reached.set_value();
      }
    });
    fdbg.addBreakpoint("stack.js", 2);

    std::thread th([&] {
      JS_UpdateStackTop(frt);
      JSValue v = JS_Eval(fctx, kStackCode, std::strlen(kStackCode), "stack.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(fctx, v);
    });

    bool got = reachedFut.wait_for(std::chrono::seconds(5)) ==
               std::future_status::ready;
    fdbg.resume();
    th.join();

    check(got && captured.size() == 4,
          "captured full stack c->b->a->top (" +
              std::to_string(captured.size()) + " frames)");
    if (captured.size() == 4) {
      check(captured[0].functionName == "c" && captured[0].line1Based == 2,
            "frame 0 = c at line 2");
      check(captured[1].functionName == "b" && captured[1].line1Based == 5,
            "frame 1 = b at call site line 5");
      check(captured[2].functionName == "a" && captured[2].line1Based == 8,
            "frame 2 = a at call site line 8");
      // QuickJS names the top-level eval function "<eval>".
      check(captured[3].functionName == "<eval>" && captured[3].line1Based == 10,
            "frame 3 = top-level <eval> at line 10");
      check(captured[0].scriptId == "stack.js",
            "frames carry the script id");
    }

    JS_FreeContext(fctx);
    JS_FreeRuntime(frt);
  }

  // --- Multi-tenant (M3.5): two contexts on one runtime, independent hooks. ---
  static const char* kMtCode =
      "globalThis.log = (globalThis.log || []);\n"  // line 1
      "log.push('x');\n"                             // line 2  <-- breakpoint
      "globalThis.done = 1;\n";                      // line 3
  {
    JSRuntime* mrt = JS_NewRuntime();
    JSContext* ctxA = JS_NewContext(mrt);
    JSContext* ctxB = JS_NewContext(mrt);
    auto coreA = std::make_unique<QuickJSDebugCore>(mrt, ctxA);
    auto coreB = std::make_unique<QuickJSDebugCore>(mrt, ctxB);

    std::atomic<int> pausesA{0}, pausesB{0};
    coreA->setPausedCallback(
        [&](const std::string&, int, PauseReason) { pausesA++; });
    coreB->setPausedCallback(
        [&](const std::string&, int, PauseReason) { pausesB++; });

    // A has a breakpoint; B does not. Running B must NOT pause (its own hook is
    // independent and empty) even though A is attached to the same runtime.
    coreA->addBreakpoint("mt.js", 2);

    std::promise<void> bDone;
    auto bFut = bDone.get_future();
    std::thread bThread([&] {
      JS_UpdateStackTop(mrt);
      JSValue v = JS_Eval(ctxB, kMtCode, std::strlen(kMtCode), "mt.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(ctxB, v);
      bDone.set_value();
    });
    check(bFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "context B ran to completion (no breakpoint of its own)");
    bThread.join();
    check(pausesB.load() == 0, "context B never paused on A's breakpoint");

    // Detach B: A must stay attached and still pause on its breakpoint.
    coreB.reset();

    std::promise<int> aPausedLine;
    auto aFut = aPausedLine.get_future();
    std::atomic<bool> aOnce{false};
    coreA->setPausedCallback([&](const std::string&, int line, PauseReason) {
      pausesA++;
      if (!aOnce.exchange(true)) aPausedLine.set_value(line);
    });
    std::promise<void> aDone;
    auto aDoneFut = aDone.get_future();
    std::thread aThread([&] {
      JS_UpdateStackTop(mrt);
      JSValue v = JS_Eval(ctxA, kMtCode, std::strlen(kMtCode), "mt.js",
                          JS_EVAL_TYPE_GLOBAL);
      JS_FreeValue(ctxA, v);
      aDone.set_value();
    });
    int al = aFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready
                 ? aFut.get()
                 : -1;
    check(al == 2, "context A still pauses after B detached (line " +
                       std::to_string(al) + ")");
    coreA->resume();
    check(aDoneFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "context A resumed to completion");
    aThread.join();

    coreA.reset();
    JS_FreeContext(ctxA);
    JS_FreeContext(ctxB);
    JS_FreeRuntime(mrt);
  }

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " ("
            << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
