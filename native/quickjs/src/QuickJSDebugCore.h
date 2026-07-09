/*
 * QuickJSDebugCore — engine-level pause/breakpoint controller for the QuickJS
 * sandbox (dev-only, gated on RILL_QJS_DEBUG).
 *
 * It registers the interpreter debug hook (quickjs-debug.h) and turns raw
 * per-line callbacks into breakpoint hits and pauses. When a breakpoint (or a
 * pause request) lands, onStep() blocks the runtime thread on a condition
 * variable — that IS the pause. resume()/requestPause() come from other threads
 * (the CDP side) and coordinate through the same lock.
 *
 * This is the M1 core: pause / resume / line breakpoints. Call frames, stepping,
 * and evaluate-on-frame build on top of it.
 */
#pragma once

#ifdef RILL_QJS_DEBUG

#include <condition_variable>
#include <functional>
#include <mutex>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

struct JSContext;
struct JSRuntime;

namespace rill::qjs_debug {

// Why the runtime paused. Core-local (kept independent of the devtools CDP
// types); QuickJSEngineDebugger translates it to rill::devtools::PauseReason.
enum class PauseReason { Breakpoint, Step, Pause };

class QuickJSDebugCore {
public:
  // Invoked on the runtime thread the moment execution pauses, before it blocks.
  using PausedFn =
      std::function<void(const std::string& scriptId, int line, PauseReason)>;

  QuickJSDebugCore(JSRuntime* rt, JSContext* ctx);
  ~QuickJSDebugCore();

  QuickJSDebugCore(const QuickJSDebugCore&) = delete;
  QuickJSDebugCore& operator=(const QuickJSDebugCore&) = delete;

  // One live call-stack frame, top (innermost) first. Line is 1-based.
  struct FrameSnapshot {
    std::string scriptId;
    std::string functionName;
    int line1Based;
  };

  void setPausedCallback(PausedFn fn);

  // Snapshot the live call stack. Runtime-thread-only: valid only while paused
  // (the frame chain must be intact), i.e. called from within the paused
  // callback. Native/stripped frames (no source location) are skipped.
  std::vector<FrameSnapshot> captureFrames();

  // Breakpoint + control surface — all safe to call from any thread.
  void addBreakpoint(const std::string& scriptId, int line);
  void removeBreakpoint(const std::string& scriptId, int line);
  void requestPause();  // pause at the next source line
  void resume();
  // Stepping: arm the mode against the paused call depth, then resume. A pause
  // (breakpoint, request, or the step landing) disarms it.
  void stepInto();
  void stepOver();
  void stepOut();
  bool isPaused();

  // Run a job on the (blocked) runtime thread while it is paused, then return.
  // Used to evaluate expressions in the paused context: the debug hook is
  // suppressed for the duration so a re-entrant eval cannot self-pause. Returns
  // false (without running) if the runtime is not currently paused. Safe to call
  // from the CDP thread only.
  using EvalJob = std::function<void(JSContext*)>;
  bool runOnPausedThread(const EvalJob& job);

  // C hook entry (registered with the engine); dispatches to onStep. `depth` is
  // the live call-stack length (1 = top-level), used by stepping.
  void onStep(JSContext* ctx, const void* scriptToken, int line, int depth);

private:
  std::string resolveScript(JSContext* ctx, const void* scriptToken);

  JSRuntime* rt_;
  JSContext* ctx_;

  enum class StepMode { None, Into, Over, Out };

  std::mutex mutex_;
  std::condition_variable cv_;
  std::condition_variable jobCv_;  // signals a paused-thread job completed
  std::set<std::pair<std::string, int>> breakpoints_;  // guarded by mutex_
  bool pauseRequested_ = false;                        // guarded by mutex_
  bool paused_ = false;                                // guarded by mutex_
  bool resumeRequested_ = false;                       // guarded by mutex_
  const EvalJob* pendingJob_ = nullptr;  // guarded by mutex_
  bool jobDone_ = false;                 // guarded by mutex_
  bool inEval_ = false;  // runtime-thread-only: suppress the hook during eval
  StepMode stepMode_ = StepMode::None;                 // guarded by mutex_
  int stepDepth_ = 0;    // call depth the step was armed at; guarded by mutex_
  int stepLine_ = 0;     // source line the step was armed at; guarded by mutex_
  int pausedDepth_ = 0;  // call depth at the current pause; guarded by mutex_
  int pausedLine_ = 0;   // source line at the current pause; guarded by mutex_

  // Runtime-thread-only state (touched only inside onStep).
  std::unordered_map<const void*, std::string> scriptNames_;
  const void* lastToken_ = nullptr;
  int lastLine_ = -1;
  int lastDepth_ = -1;

  PausedFn onPaused_;  // set once before debugging starts
};

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
