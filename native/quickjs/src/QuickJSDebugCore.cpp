#include "QuickJSDebugCore.h"

#ifdef RILL_QJS_DEBUG

#include "quickjs-debug.h"

namespace rill::qjs_debug {

namespace {
// extern "C" trampoline: the engine hook is a C function pointer.
extern "C" void rill_qjs_hook_thunk(JSContext* ctx, const void* token, int line,
                                    void* opaque) {
  static_cast<QuickJSDebugCore*>(opaque)->onStep(ctx, token, line);
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

void QuickJSDebugCore::onStep(JSContext* ctx, const void* token, int line) {
  // Fire once per source line, not per instruction on that line.
  if (token == lastToken_ && line == lastLine_) return;
  lastToken_ = token;
  lastLine_ = line;

  std::string scriptId = resolveScript(ctx, token);

  std::unique_lock<std::mutex> lk(mutex_);
  bool shouldPause = pauseRequested_ || breakpoints_.count({scriptId, line}) > 0;
  if (!shouldPause) return;
  pauseRequested_ = false;

  // Enter the pause. Notify the observer (still holding nothing that resume
  // needs), then block the runtime thread until resume() flips the flag.
  paused_ = true;
  resumeRequested_ = false;
  if (onPaused_) {
    lk.unlock();
    onPaused_(scriptId, line);
    lk.lock();
  }
  cv_.wait(lk, [&] { return resumeRequested_; });
  paused_ = false;
}

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
