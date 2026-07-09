#include "QuickJSDebugCore.h"

#ifdef RILL_QJS_DEBUG

#include "quickjs-debug.h"

namespace rill::qjs_debug {

namespace {
// extern "C" trampoline: the engine hook is a C function pointer.
extern "C" void rill_qjs_hook_thunk(JSContext* ctx, const void* token, int line,
                                    int depth, void* opaque) {
  static_cast<QuickJSDebugCore*>(opaque)->onStep(ctx, token, line, depth);
}
}  // namespace

QuickJSDebugCore::QuickJSDebugCore(JSRuntime* rt, JSContext* ctx)
    : rt_(rt), ctx_(ctx) {
  rill_qjs_set_debug_hook(rt_, &rill_qjs_hook_thunk, this);
}

QuickJSDebugCore::~QuickJSDebugCore() {
  rill_qjs_set_debug_hook(rt_, nullptr, nullptr);
}

void QuickJSDebugCore::setPausedCallback(PausedFn fn) {
  onPaused_ = std::move(fn);
}

void QuickJSDebugCore::addBreakpoint(const std::string& scriptId, int line) {
  std::lock_guard<std::mutex> lk(mutex_);
  breakpoints_.insert({scriptId, line});
}

void QuickJSDebugCore::removeBreakpoint(const std::string& scriptId, int line) {
  std::lock_guard<std::mutex> lk(mutex_);
  breakpoints_.erase({scriptId, line});
}

void QuickJSDebugCore::requestPause() {
  std::lock_guard<std::mutex> lk(mutex_);
  pauseRequested_ = true;
}

void QuickJSDebugCore::resume() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::None;
    resumeRequested_ = true;
  }
  cv_.notify_all();
}

void QuickJSDebugCore::stepInto() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Into;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  cv_.notify_all();
}

void QuickJSDebugCore::stepOver() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Over;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  cv_.notify_all();
}

void QuickJSDebugCore::stepOut() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Out;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  cv_.notify_all();
}

bool QuickJSDebugCore::isPaused() {
  std::lock_guard<std::mutex> lk(mutex_);
  return paused_;
}

std::string QuickJSDebugCore::resolveScript(JSContext* ctx, const void* token) {
  auto it = scriptNames_.find(token);
  if (it != scriptNames_.end()) return it->second;
  std::string name;
  const char* fn = rill_qjs_script_filename(ctx, token);
  if (fn) {
    name = fn;
    JS_FreeCString(ctx, fn);
  }
  scriptNames_.emplace(token, name);
  return name;
}

void QuickJSDebugCore::onStep(JSContext* ctx, const void* token, int line,
                              int depth) {
  // Fire once per (source line, call depth): the same line re-entered at a
  // different depth (recursion, or a step that returns to it) must re-evaluate.
  if (token == lastToken_ && line == lastLine_ && depth == lastDepth_) return;
  lastToken_ = token;
  lastLine_ = line;
  lastDepth_ = depth;

  std::string scriptId = resolveScript(ctx, token);

  std::unique_lock<std::mutex> lk(mutex_);
  const bool bpHit = breakpoints_.count({scriptId, line}) > 0;
  // Stepping ignores the line it was armed at (so returning to a call site after
  // the callee finishes isn't mistaken for progress); it lands on the first
  // genuinely new source line consistent with the requested granularity.
  const bool leftStart = depth != stepDepth_ || line != stepLine_;
  bool stepHit = false;
  switch (stepMode_) {
    case StepMode::Into: stepHit = leftStart; break;   // any new line, any depth
    case StepMode::Over:                                // new line, not deeper
      stepHit = depth < stepDepth_ || (depth == stepDepth_ && line != stepLine_);
      break;
    case StepMode::Out: stepHit = depth < stepDepth_; break;  // shallower only
    case StepMode::None: break;
  }
  const bool shouldPause = pauseRequested_ || bpHit || stepHit;
  if (!shouldPause) return;

  // A breakpoint wins the reason even if a step also landed here; an explicit
  // pause request outranks a step. Consuming the pause disarms any step.
  const PauseReason reason =
      bpHit ? PauseReason::Breakpoint
            : (pauseRequested_ ? PauseReason::Pause : PauseReason::Step);
  pauseRequested_ = false;
  stepMode_ = StepMode::None;

  // Enter the pause. Notify the observer (still holding nothing that resume
  // needs), then block the runtime thread until resume() flips the flag.
  paused_ = true;
  pausedDepth_ = depth;
  pausedLine_ = line;
  resumeRequested_ = false;
  if (onPaused_) {
    lk.unlock();
    onPaused_(scriptId, line, reason);
    lk.lock();
  }
  cv_.wait(lk, [&] { return resumeRequested_; });
  paused_ = false;
}

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
