/**
 * DebuggerAdapter.h
 *
 * P3-Y.6: Debugger Domain Adapter
 *
 * Provides debugging capabilities via CDP Debugger domain:
 *   - Debugger.enable/disable
 *   - Debugger.setBreakpoint/removeBreakpoint
 *   - Debugger.pause/resume/stepOver/stepInto/stepOut
 *   - Debugger.evaluateOnCallFrame
 *   - Debugger.paused/resumed events
 *
 * Supports multiple JS engines:
 *   - JSC: JavaScriptCore debugging API
 *   - Hermes: Hermes CDP integration
 *   - QuickJS: Custom debugging hooks
 */

#pragma once

#include "CDPServer.h"
#include <functional>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>

namespace rill::devtools {

// ============================================
// Debugger Types
// ============================================

/**
 * Script information
 */
struct ScriptInfo {
  std::string scriptId;
  std::string url;
  std::string sourceMapURL;
  int startLine = 0;
  int startColumn = 0;
  int endLine = 0;
  int endColumn = 0;
  std::string hash;
  bool hasSourceURL = false;
};

/**
 * Breakpoint information
 */
struct BreakpointInfo {
  std::string breakpointId;
  std::string scriptId;
  int lineNumber = 0;
  int columnNumber = 0;
  std::string condition;  // Optional condition expression
  bool enabled = true;
};

/**
 * Call frame information (when paused)
 */
struct CallFrame {
  std::string callFrameId;
  std::string functionName;
  std::string scriptId;
  std::string url;
  int lineNumber = 0;
  int columnNumber = 0;
  
  // Scope chain (simplified)
  struct Scope {
    std::string type;  // "local", "closure", "global"
    std::string objectId;
    std::string name;
  };
  std::vector<Scope> scopeChain;
  
  // this object
  std::string thisObjectId;
};

/**
 * Pause reason
 */
enum class PauseReason {
  Breakpoint,
  Exception,
  DebugCommand,
  Step,
  Other
};

inline const char* pauseReasonToString(PauseReason reason) {
  switch (reason) {
    case PauseReason::Breakpoint:    return "breakpoint";
    case PauseReason::Exception:     return "exception";
    case PauseReason::DebugCommand:  return "debugCommand";
    case PauseReason::Step:          return "step";
    default:                         return "other";
  }
}

/**
 * Step action
 */
enum class StepAction {
  StepOver,
  StepInto,
  StepOut,
  Continue
};

// ============================================
// Engine Debugger Interface
// ============================================

/**
 * Abstract interface for engine-specific debugging
 * Implemented separately for JSC, Hermes, QuickJS
 */
class IEngineDebugger {
public:
  virtual ~IEngineDebugger() = default;
  
  /**
   * Enable debugging for a tenant
   */
  virtual bool enable(TenantId tenantId) = 0;
  
  /**
   * Disable debugging
   */
  virtual void disable(TenantId tenantId) = 0;
  
  /**
   * Set breakpoint
   * @return Breakpoint ID if successful
   */
  virtual std::optional<std::string> setBreakpoint(
      TenantId tenantId,
      const std::string& scriptId,
      int lineNumber,
      int columnNumber,
      const std::string& condition) = 0;
  
  /**
   * Remove breakpoint
   */
  virtual bool removeBreakpoint(TenantId tenantId, const std::string& breakpointId) = 0;
  
  /**
   * Pause execution
   */
  virtual void pause(TenantId tenantId) = 0;
  
  /**
   * Resume execution
   */
  virtual void resume(TenantId tenantId) = 0;
  
  /**
   * Step action
   */
  virtual void step(TenantId tenantId, StepAction action) = 0;
  
  /**
   * Evaluate expression on call frame
   */
  virtual std::string evaluateOnCallFrame(
      TenantId tenantId,
      const std::string& callFrameId,
      const std::string& expression) = 0;

  /**
   * Get the properties of an object/scope by objectId (Runtime.getProperties),
   * e.g. a call frame's scope object. Returns a CDP result payload
   * {"result":[<PropertyDescriptor>...]}. Non-pure so engines that do not
   * support scope inspection inherit an empty result.
   */
  virtual std::string getProperties(TenantId /*tenantId*/,
                                    const std::string& /*objectId*/) {
    return R"({"result":[]})";
  }

  /**
   * Get current call frames (when paused)
   */
  virtual std::vector<CallFrame> getCallFrames(TenantId tenantId) = 0;
  
  /**
   * Get scripts for tenant
   */
  virtual std::vector<ScriptInfo> getScripts(TenantId tenantId) = 0;
  
  /**
   * Get script source
   */
  virtual std::string getScriptSource(TenantId tenantId, const std::string& scriptId) = 0;
  
  /**
   * Check if currently paused
   */
  virtual bool isPaused(TenantId tenantId) = 0;
};

// ============================================
// Debugger Adapter
// ============================================

/**
 * CDP Debugger domain adapter
 */
class DebuggerAdapter {
public:
  // Raw CDP event JSON sink. The relay layer (AdapterDebugTarget) wires this to
  // broadcast events to the tenant's connected DevTools clients through the same
  // persistent per-connection sinks that carry command responses — so events and
  // responses share one path, consistent with the CDP-native (Hermes) engine.
  using EventSink = std::function<void(const std::string& rawEventJson)>;

  DebuggerAdapter();
  ~DebuggerAdapter() = default;

  // Non-copyable
  DebuggerAdapter(const DebuggerAdapter&) = delete;
  DebuggerAdapter& operator=(const DebuggerAdapter&) = delete;

  // Wire (or clear, with nullptr) the event broadcast sink.
  void setEventSink(EventSink sink);

  /**
   * Set engine debugger implementation
   */
  void setEngineDebugger(std::shared_ptr<IEngineDebugger> debugger);
  
  // ============================================
  // CDP Method Handlers
  // ============================================
  
  CDPResponse handleEnable(TenantId tenantId, int requestId);
  CDPResponse handleDisable(TenantId tenantId, int requestId);
  
  CDPResponse handleSetBreakpointByUrl(TenantId tenantId, int requestId, 
                                        const std::string& params);
  CDPResponse handleSetBreakpoint(TenantId tenantId, int requestId,
                                   const std::string& params);
  CDPResponse handleRemoveBreakpoint(TenantId tenantId, int requestId,
                                      const std::string& params);
  
  CDPResponse handlePause(TenantId tenantId, int requestId);
  CDPResponse handleResume(TenantId tenantId, int requestId);
  CDPResponse handleStepOver(TenantId tenantId, int requestId);
  CDPResponse handleStepInto(TenantId tenantId, int requestId);
  CDPResponse handleStepOut(TenantId tenantId, int requestId);
  
  CDPResponse handleEvaluateOnCallFrame(TenantId tenantId, int requestId,
                                         const std::string& params);
  CDPResponse handleGetScriptSource(TenantId tenantId, int requestId,
                                     const std::string& params);
  CDPResponse handleSetPauseOnExceptions(TenantId tenantId, int requestId,
                                          const std::string& params);
  // Runtime.getProperties — scope / object expansion by objectId. The engine
  // returns a full {"result":[...]} payload. On the multi-target native path the
  // Runtime domain is owned by RuntimeAdapter, so this is reached only where the
  // Debugger target also fronts Runtime.getProperties (the fat single-engine
  // CDP wasm), letting a GUI expand paused scopes without a separate adapter.
  CDPResponse handleGetProperties(TenantId tenantId, int requestId,
                                   const std::string& params);

  // ============================================
  // Event Emitters
  // ============================================
  
  /**
   * Called when execution pauses (breakpoint, exception, etc.)
   */
  void onPaused(TenantId tenantId, PauseReason reason,
                const std::vector<CallFrame>& callFrames,
                const std::vector<std::string>& hitBreakpoints = {});
  
  /**
   * Called when execution resumes
   */
  void onResumed(TenantId tenantId);
  
  /**
   * Called when a new script is loaded
   */
  void onScriptParsed(TenantId tenantId, const ScriptInfo& script);
  
  /**
   * Called when script parsing fails
   */
  void onScriptFailedToParse(TenantId tenantId, const ScriptInfo& script,
                              const std::string& errorMessage);

private:
  /**
   * Build CallFrame JSON
   */
  std::string callFrameToJSON(const CallFrame& frame);
  
  /**
   * Build ScriptInfo JSON for scriptParsed event
   */
  std::string scriptInfoToJSON(const ScriptInfo& script);
  
  /**
   * Generate unique breakpoint ID
   */
  std::string generateBreakpointId();

  // Serialize + emit a CDP event through the wired sink (no-op if unset).
  void emitEvent(const CDPEvent& event);

  EventSink eventSink_;
  std::shared_ptr<IEngineDebugger> engineDebugger_;
  
  // Per-tenant state
  struct TenantDebugState {
    bool enabled = false;
    std::unordered_map<std::string, BreakpointInfo> breakpoints;
    std::string pauseOnExceptions = "none";  // "none", "uncaught", "all"
  };
  
  std::unordered_map<TenantId, TenantDebugState> tenantStates_;
  std::mutex stateMutex_;
  
  std::atomic<uint64_t> nextBreakpointId_{1};
};

// ============================================
// Stub Engine Debugger (No-op)
// ============================================

/**
 * Stub implementation when no real debugger is available
 */
class StubEngineDebugger : public IEngineDebugger {
public:
  bool enable(TenantId) override { return true; }
  void disable(TenantId) override {}
  
  std::optional<std::string> setBreakpoint(TenantId, const std::string&,
                                            int, int, const std::string&) override {
    return std::nullopt;
  }
  
  bool removeBreakpoint(TenantId, const std::string&) override { return false; }
  void pause(TenantId) override {}
  void resume(TenantId) override {}
  void step(TenantId, StepAction) override {}
  
  std::string evaluateOnCallFrame(TenantId, const std::string&,
                                   const std::string&) override {
    return R"({"type":"undefined"})";
  }
  
  std::vector<CallFrame> getCallFrames(TenantId) override { return {}; }
  std::vector<ScriptInfo> getScripts(TenantId) override { return {}; }
  std::string getScriptSource(TenantId, const std::string&) override { return ""; }
  bool isPaused(TenantId) override { return false; }
};

} // namespace rill::devtools
