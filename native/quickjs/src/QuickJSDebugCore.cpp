#include "QuickJSDebugCore.h"

#ifdef RILL_QJS_DEBUG

#include "quickjs-debug.h"

#if defined(__EMSCRIPTEN__)
// The Asyncify suspend/wake shim (native/quickjs/src/qjs_dbg_suspend.c), compiled
// only into the debug wasm. suspend unwinds the whole C stack back to the JS
// event loop and returns only after wake + rewind.
extern "C" void rill_qjs_dbg_suspend_async(void);
extern "C" void rill_qjs_dbg_wake(void);
#endif

namespace rill::qjs_debug {

namespace {
// extern "C" trampoline: the engine hook is a C function pointer.
extern "C" void rill_qjs_hook_thunk(JSContext* ctx, const void* token, int line,
                                    int depth, void* opaque) {
  static_cast<QuickJSDebugCore*>(opaque)->onStep(ctx, token, line, depth);
}

// One raw frame as emitted by the engine walk, before scriptId resolution.
struct RawFrame {
  const void* token;
  int line;
  std::string name;
};
// extern "C" sink for rill_qjs_capture_frames; copies the borrowed name.
extern "C" void rill_qjs_capture_sink(void* user, const void* token, int line,
                                      const char* name) {
  static_cast<std::vector<RawFrame>*>(user)->push_back(
      {token, line, name ? std::string(name) : std::string()});
}

#if defined(__EMSCRIPTEN__)
// Sink for the web binding capture: dup each borrowed frame value into an owned
// CapturedVar so it outlives the imminent Asyncify unwind.
struct VarCapture {
  JSContext* ctx;
  std::vector<QuickJSDebugCore::CapturedVar>* out;
};
extern "C" void rill_qjs_dup_var_sink(void* user, const char* name,
                                      JSValueConst value) {
  auto* c = static_cast<VarCapture*>(user);
  c->out->push_back(
      {name ? std::string(name) : std::string(), JS_DupValue(c->ctx, value)});
}
#endif
}  // namespace

QuickJSDebugCore::QuickJSDebugCore(JSRuntime* rt, JSContext* ctx) : ctx_(ctx) {
  (void)rt;  // runtime no longer needed: the hook is keyed per-context
  // The hook is keyed per-context, so each tenant attaches/detaches on its own.
  rill_qjs_set_debug_hook(ctx_, &rill_qjs_hook_thunk, this);
}

QuickJSDebugCore::~QuickJSDebugCore() {
  rill_qjs_set_debug_hook(ctx_, nullptr, nullptr);
  // Defensive (web): if the core is torn down while a pause is still parked (an
  // unusual teardown-before-resume), free the snapshot dups here rather than
  // leaking them; ctx_ still outlives the core. No-op on native / when empty.
  freeSnapshotBindings();
}

void QuickJSDebugCore::setPausedCallback(PausedFn fn) {
  onPaused_ = std::move(fn);
}

void QuickJSDebugCore::setScriptSeenCallback(ScriptSeenFn fn) {
  onScriptSeen_ = std::move(fn);
}

void QuickJSDebugCore::setResumingCallback(ResumingFn fn) {
  onResuming_ = std::move(fn);
}

std::vector<QuickJSDebugCore::FrameSnapshot> QuickJSDebugCore::captureFrames() {
  std::vector<RawFrame> raw;
  rill_qjs_capture_frames(ctx_, &rill_qjs_capture_sink, &raw);
  std::vector<FrameSnapshot> out;
  out.reserve(raw.size());
  for (auto& r : raw) {
    if (!r.token || r.line < 0) continue;  // native/stripped frame: no location
    out.push_back({resolveScript(ctx_, r.token), std::move(r.name), r.line});
  }
  return out;
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
  wakeFromPause();
}

void QuickJSDebugCore::stepInto() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Into;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  wakeFromPause();
}

void QuickJSDebugCore::stepOver() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Over;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  wakeFromPause();
}

void QuickJSDebugCore::stepOut() {
  {
    std::lock_guard<std::mutex> lk(mutex_);
    stepMode_ = StepMode::Out;
    stepDepth_ = pausedDepth_;
    stepLine_ = pausedLine_;
    resumeRequested_ = true;
  }
  wakeFromPause();
}

bool QuickJSDebugCore::isPaused() {
  std::lock_guard<std::mutex> lk(mutex_);
  return paused_;
}

bool QuickJSDebugCore::runOnPausedThread(const EvalJob& job) {
#if defined(__EMSCRIPTEN__)
  // Web: there is no blocked runtime thread — the pause unwound the C stack. But
  // while paused we ARE on the single JS thread inside the Asyncify await window
  // (unwind complete, Asyncify idle), so we run the job right here. Two guards:
  //  - rt->current_stack_frame dangles into the unwound C stack; null it so a
  //    fresh JS_Eval/JS_Call, and any exception backtrace (build_backtrace) it
  //    walks, never touches the freed frames. Restore the saved token after — it
  //    becomes valid again once Asyncify rewinds on resume.
  //  - suppress the debug hook (inEval_) so the job's own execution cannot
  //    re-pause; a nested Asyncify unwind is impossible and would corrupt state.
  // The job reads the pre-unwind binding snapshot (pausedBindings()), not the
  // gone live frames.
  if (!paused_) return false;
  // Restore the frame pointer and inEval_ no matter how job() exits. A skipped
  // restore would strand current_stack_frame at NULL (so the next GC during
  // rewind would not root the suspended frame's live values) and leave inEval_
  // stuck true (so the debugger never pauses again). The debug wasm builds with
  // C++ exceptions off, so this is belt-and-suspenders today, but it keeps the
  // invariant regardless of how job() returns.
  struct Restore {
    bool* inEval;
    bool prevInEval;
    JSContext* ctx;
    void* savedFrame;
    ~Restore() {
      *inEval = prevInEval;
      rill_qjs_set_current_frame(ctx, savedFrame);
    }
  } restore{&inEval_, inEval_, ctx_, rill_qjs_current_frame(ctx_)};
  rill_qjs_set_current_frame(ctx_, nullptr);
  inEval_ = true;
  job(ctx_);
  return true;
#else
  std::unique_lock<std::mutex> lk(mutex_);
  if (!paused_) return false;  // no blocked runtime thread to run the job
  pendingJob_ = &job;
  jobDone_ = false;
  cv_.notify_all();  // wake the pause loop to pick up the job
  jobCv_.wait(lk, [&] { return jobDone_; });
  return true;
#endif
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
  // First time this script (by url) is seen: announce it with its source. Runs
  // on the runtime thread, no lock held here, so the callback is free to emit.
  if (!name.empty() && seenScripts_.insert(name).second && onScriptSeen_) {
    std::string source;
    std::size_t len = 0;
    const char* src = rill_qjs_script_source(token, &len);  // borrowed
    if (src) source.assign(src, len);
    onScriptSeen_(name, name, source);
  }
  return name;
}

void QuickJSDebugCore::onStep(JSContext* ctx, const void* token, int line,
                              int depth) {
  // Suppress the hook while evaluating in the paused context: a re-entrant eval
  // runs on this same thread and would otherwise self-pause / recurse.
  if (inEval_) return;
#if defined(__EMSCRIPTEN__)
  // Web: the pause unwinds the C stack instead of blocking a thread, so guest
  // bytecode CAN run while already parked (a second eval entry, or a host that
  // pumps QuickJS promise jobs during the await). A nested pause is impossible
  // to honor with the single Asyncify resolver — it would overwrite the outer
  // resolver and hang the outer eval forever — so refuse to re-pause. (Native
  // blocks the runtime thread inside suspendAtPause, so this cannot arise.)
  if (paused_) return;
#endif
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
  // needs), then suspend the runtime until resume()/step wakes it.
  paused_ = true;
  pausedDepth_ = depth;
  pausedLine_ = line;
  resumeRequested_ = false;
  if (onPaused_) {
    lk.unlock();
    onPaused_(scriptId, line, reason);
    lk.lock();
  }
  suspendAtPause(ctx, lk);
  // Pause exit, still on the runtime thread and under lk: let an observer free
  // pause-scoped state (e.g. the engine's object registry of dup'd JSValues)
  // here, where freeing is thread-safe. inEval_ suppresses a re-entrant onStep
  // if freeing runs a finalizer; keep lk held (no unlock window) so a CDP
  // runOnPausedThread cannot see paused_==true and enqueue a job after the pump
  // has exited.
  if (onResuming_) {
    inEval_ = true;
    onResuming_(ctx_);
    inEval_ = false;
  }
  paused_ = false;
}

void QuickJSDebugCore::suspendAtPause(JSContext* ctx,
                                     std::unique_lock<std::mutex>& lk) {
#if defined(__EMSCRIPTEN__)
  // Web (single JS thread, no real threads): capture the frames BEFORE the stack
  // unwinds — after the Asyncify unwind ctx->rt->current_stack_frame is gone —
  // then hand control back to the JS event loop. rill_qjs_dbg_suspend_async()
  // returns only once resume()/step calls the stored resolver and Asyncify
  // rewinds. runOnPausedThread is unavailable here, so no cv_/job pump.
  (void)ctx;
  (void)lk;
  buildSnapshot();
  rill_qjs_dbg_suspend_async();
  freeSnapshot();
#else
  // Native: block the runtime thread on cv_, staying responsive to eval jobs
  // dispatched from the CDP thread (run each here with the hook suppressed),
  // until resume()/step flips resumeRequested_.
  (void)ctx;
  while (true) {
    cv_.wait(lk, [&] { return resumeRequested_ || pendingJob_ != nullptr; });
    if (pendingJob_ != nullptr) {
      const EvalJob* job = pendingJob_;
      pendingJob_ = nullptr;
      inEval_ = true;
      lk.unlock();
      (*job)(ctx_);
      lk.lock();
      inEval_ = false;
      jobDone_ = true;
      jobCv_.notify_all();
      continue;
    }
    break;  // resumeRequested_
  }
#endif
}

void QuickJSDebugCore::wakeFromPause() {
#if defined(__EMSCRIPTEN__)
  rill_qjs_dbg_wake();
#else
  cv_.notify_all();
#endif
}

void QuickJSDebugCore::buildSnapshot() {
  snapshotFrames_ = captureFrames();
#if defined(__EMSCRIPTEN__)
  // Web only: capture every frame's bindings (dup'd) BEFORE the Asyncify unwind,
  // so an evaluate arriving after the unwind — when the live frames are gone —
  // can reconstruct the frame scope from this immutable snapshot. Native reads
  // live frames instead and never populates this. Frame indexing matches
  // captureFrames()/rill_qjs_nth_frame (located JS frames, top first).
  freeSnapshotBindings();  // release any prior pause's dups before recapturing
  snapshotBindings_.resize(snapshotFrames_.size());
  for (std::size_t i = 0; i < snapshotFrames_.size(); ++i) {
    FrameBindings& fb = snapshotBindings_[i];
    VarCapture ac{ctx_, &fb.args};
    rill_qjs_enumerate_frame_vars(ctx_, static_cast<int>(i), RILL_QJS_VAR_ARG,
                                  &rill_qjs_dup_var_sink, &ac);
    VarCapture lc{ctx_, &fb.locals};
    rill_qjs_enumerate_frame_vars(ctx_, static_cast<int>(i), RILL_QJS_VAR_LOCAL,
                                  &rill_qjs_dup_var_sink, &lc);
    VarCapture cc{ctx_, &fb.closures};
    rill_qjs_enumerate_frame_vars(ctx_, static_cast<int>(i), RILL_QJS_VAR_CLOSURE,
                                  &rill_qjs_dup_var_sink, &cc);
    fb.thisVal = JS_DupValue(ctx_, rill_qjs_frame_this(ctx_, static_cast<int>(i)));
  }
#endif
}

void QuickJSDebugCore::freeSnapshot() {
  snapshotFrames_.clear();
  freeSnapshotBindings();
}

void QuickJSDebugCore::freeSnapshotBindings() {
#if defined(__EMSCRIPTEN__)
  for (auto& fb : snapshotBindings_) {
    for (auto& v : fb.args) JS_FreeValue(ctx_, v.value);
    for (auto& v : fb.locals) JS_FreeValue(ctx_, v.value);
    for (auto& v : fb.closures) JS_FreeValue(ctx_, v.value);
    JS_FreeValue(ctx_, fb.thisVal);
  }
  snapshotBindings_.clear();
#endif
}

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
