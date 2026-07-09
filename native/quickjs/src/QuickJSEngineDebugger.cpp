#include "QuickJSEngineDebugger.h"

#ifdef RILL_QJS_DEBUG

namespace rill::qjs_debug {

namespace rd = rill::devtools;

QuickJSEngineDebugger::QuickJSEngineDebugger(QuickJSDebugCore* core,
                                             rd::TenantId tenantId)
    : core_(core), tenantId_(tenantId) {
  core_->setPausedCallback(
      [this](const std::string& scriptId, int line1Based) {
        onCorePaused(scriptId, line1Based);
      });
}

QuickJSEngineDebugger::~QuickJSEngineDebugger() {
  // Detach from the core before we die: clear the paused callback (it captures
  // this) and drop our breakpoints so a still-live core can't pause with no
  // observer. The core outlives us (owned by the sandbox context, torn down
  // after the debug target).
  core_->setPausedCallback(nullptr);
  std::lock_guard<std::mutex> lk(mutex_);
  for (const auto& [id, loc] : breakpoints_) {
    core_->removeBreakpoint(loc.first, loc.second);
  }
  breakpoints_.clear();
}

void QuickJSEngineDebugger::setPausedNotifier(PausedNotifier fn) {
  notifier_ = std::move(fn);
}

bool QuickJSEngineDebugger::enable(rd::TenantId) { return true; }

void QuickJSEngineDebugger::disable(rd::TenantId) {
  std::lock_guard<std::mutex> lk(mutex_);
  for (const auto& [id, loc] : breakpoints_) {
    core_->removeBreakpoint(loc.first, loc.second);
  }
  breakpoints_.clear();
}

std::optional<std::string> QuickJSEngineDebugger::setBreakpoint(
    rd::TenantId, const std::string& scriptId, int lineNumber,
    int /*columnNumber*/, const std::string& /*condition*/) {
  const int line1Based = lineNumber + 1;  // CDP 0-based -> QuickJS 1-based
  std::string id;
  {
    std::lock_guard<std::mutex> lk(mutex_);
    id = std::to_string(nextBreakpointId_++);
    breakpoints_.emplace(id, std::make_pair(scriptId, line1Based));
  }
  core_->addBreakpoint(scriptId, line1Based);
  return id;
}

bool QuickJSEngineDebugger::removeBreakpoint(rd::TenantId,
                                             const std::string& breakpointId) {
  std::pair<std::string, int> loc;
  {
    std::lock_guard<std::mutex> lk(mutex_);
    auto it = breakpoints_.find(breakpointId);
    if (it == breakpoints_.end()) return false;
    loc = it->second;
    breakpoints_.erase(it);
  }
  core_->removeBreakpoint(loc.first, loc.second);
  return true;
}

void QuickJSEngineDebugger::pause(rd::TenantId) { core_->requestPause(); }

void QuickJSEngineDebugger::resume(rd::TenantId) { core_->resume(); }

void QuickJSEngineDebugger::step(rd::TenantId, rd::StepAction /*action*/) {
  // M3: precise stepping. For now, continue so a step request never wedges.
  core_->resume();
}

std::string QuickJSEngineDebugger::evaluateOnCallFrame(
    rd::TenantId, const std::string& /*callFrameId*/,
    const std::string& /*expression*/) {
  return "{}";  // M3
}

std::vector<rd::CallFrame> QuickJSEngineDebugger::getCallFrames(rd::TenantId) {
  std::lock_guard<std::mutex> lk(mutex_);
  return lastFrames_;
}

std::vector<rd::ScriptInfo> QuickJSEngineDebugger::getScripts(rd::TenantId) {
  return {};  // M3: script registry / scriptParsed
}

std::string QuickJSEngineDebugger::getScriptSource(rd::TenantId,
                                                   const std::string&) {
  return "";  // M3
}

bool QuickJSEngineDebugger::isPaused(rd::TenantId) { return core_->isPaused(); }

void QuickJSEngineDebugger::onCorePaused(const std::string& scriptId,
                                         int line1Based) {
  rd::CallFrame frame;
  frame.callFrameId = "0";
  frame.scriptId = scriptId;
  frame.url = scriptId;
  frame.lineNumber = line1Based - 1;  // QuickJS 1-based -> CDP 0-based
  frame.columnNumber = 0;

  std::vector<rd::CallFrame> frames{frame};
  {
    std::lock_guard<std::mutex> lk(mutex_);
    lastFrames_ = frames;
  }
  if (notifier_) notifier_(rd::PauseReason::Breakpoint, frames, {});
}

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
