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

struct JSContext;
struct JSRuntime;

namespace rill::qjs_debug {

class QuickJSDebugCore {
public:
  // Invoked on the runtime thread the moment execution pauses, before it blocks.
  using PausedFn = std::function<void(const std::string& scriptId, int line)>;

  QuickJSDebugCore(JSRuntime* rt, JSContext* ctx);
  ~QuickJSDebugCore();

  QuickJSDebugCore(const QuickJSDebugCore&) = delete;
  QuickJSDebugCore& operator=(const QuickJSDebugCore&) = delete;

  void setPausedCallback(PausedFn fn);

  // Breakpoint + control surface — all safe to call from any thread.
  void addBreakpoint(const std::string& scriptId, int line);
  void removeBreakpoint(const std::string& scriptId, int line);
  void requestPause();  // pause at the next source line
  void resume();
  bool isPaused();

  // C hook entry (registered with the engine); dispatches to onStep. `depth` is
  // the live call-stack length (1 = top-level), used by stepping.
  void onStep(JSContext* ctx, const void* scriptToken, int line, int depth);

private:
  std::string resolveScript(JSContext* ctx, const void* scriptToken);

  JSRuntime* rt_;
  JSContext* ctx_;

  std::mutex mutex_;
  std::condition_variable cv_;
  std::set<std::pair<std::string, int>> breakpoints_;  // guarded by mutex_
  bool pauseRequested_ = false;                        // guarded by mutex_
  bool paused_ = false;                                // guarded by mutex_
  bool resumeRequested_ = false;                       // guarded by mutex_

  // Runtime-thread-only state (touched only inside onStep).
  std::unordered_map<const void*, std::string> scriptNames_;
  const void* lastToken_ = nullptr;
  int lastLine_ = -1;

  PausedFn onPaused_;  // set once before debugging starts
};

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
