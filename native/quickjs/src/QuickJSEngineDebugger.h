/*
 * QuickJSEngineDebugger — implements rill::devtools::IEngineDebugger on top of
 * QuickJSDebugCore, so the shared DebuggerAdapter / AdapterDebugTarget relay can
 * drive the QuickJS engine over CDP (dev-only, gated on RILL_QJS_DEBUG).
 *
 * M2 scope: enable/disable, line breakpoints, pause/resume, isPaused, and the
 * Debugger.paused notification (a single synthetic call frame). Call frames with
 * real scopes, stepping, and evaluate-on-frame are M3.
 *
 * Line numbers: CDP is 0-based; QuickJS (pc2line) is 1-based. Converted at the
 * boundary here.
 */
#pragma once

#ifdef RILL_QJS_DEBUG

#include "devtools/DebuggerAdapter.h"  // IEngineDebugger + CDP types (native/core)

#include "QuickJSDebugCore.h"

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace rill::qjs_debug {

class QuickJSEngineDebugger : public rill::devtools::IEngineDebugger {
public:
  // Emits a Debugger.paused. Wired by the assembler to DebuggerAdapter::onPaused.
  using PausedNotifier = std::function<void(
      rill::devtools::PauseReason,
      const std::vector<rill::devtools::CallFrame>&,
      const std::vector<std::string>& hitBreakpoints)>;

  QuickJSEngineDebugger(QuickJSDebugCore* core, rill::devtools::TenantId tenantId);
  ~QuickJSEngineDebugger() override;

  void setPausedNotifier(PausedNotifier fn);

  // IEngineDebugger
  bool enable(rill::devtools::TenantId) override;
  void disable(rill::devtools::TenantId) override;
  std::optional<std::string> setBreakpoint(rill::devtools::TenantId,
                                           const std::string& scriptId,
                                           int lineNumber, int columnNumber,
                                           const std::string& condition) override;
  bool removeBreakpoint(rill::devtools::TenantId,
                        const std::string& breakpointId) override;
  void pause(rill::devtools::TenantId) override;
  void resume(rill::devtools::TenantId) override;
  void step(rill::devtools::TenantId, rill::devtools::StepAction action) override;
  std::string evaluateOnCallFrame(rill::devtools::TenantId,
                                  const std::string& callFrameId,
                                  const std::string& expression) override;
  std::vector<rill::devtools::CallFrame> getCallFrames(rill::devtools::TenantId) override;
  std::vector<rill::devtools::ScriptInfo> getScripts(rill::devtools::TenantId) override;
  std::string getScriptSource(rill::devtools::TenantId,
                              const std::string& scriptId) override;
  bool isPaused(rill::devtools::TenantId) override;

private:
  // Runs on the QuickJS runtime thread when execution pauses.
  void onCorePaused(const std::string& scriptId, int line1Based,
                    PauseReason reason);
  static rill::devtools::PauseReason toCdpReason(PauseReason reason);

  QuickJSDebugCore* core_;
  rill::devtools::TenantId tenantId_;
  PausedNotifier notifier_;

  std::mutex mutex_;
  std::uint64_t nextBreakpointId_ = 1;  // guarded by mutex_
  // engine breakpoint id -> (scriptId, 1-based line)
  std::unordered_map<std::string, std::pair<std::string, int>> breakpoints_;
  std::vector<rill::devtools::CallFrame> lastFrames_;  // last pause; guarded by mutex_
};

}  // namespace rill::qjs_debug

#endif  // RILL_QJS_DEBUG
