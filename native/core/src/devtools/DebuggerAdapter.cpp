// WIP subsystem — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in devtools/CDPServer.h.
#if RILL_WIP_CDP_DEVTOOLS
/**
 * DebuggerAdapter.cpp
 *
 * P3-Y.6: Debugger Domain Adapter Implementation
 */

#include "DebuggerAdapter.h"
#include <sstream>

namespace rill::devtools {

DebuggerAdapter::DebuggerAdapter()
    : engineDebugger_(std::make_shared<StubEngineDebugger>()) {}

void DebuggerAdapter::setEventSink(EventSink sink) {
  eventSink_ = std::move(sink);
}

void DebuggerAdapter::emitEvent(const CDPEvent& event) {
  if (eventSink_) eventSink_(cdp::buildEventJSON(event.method, event.params));
}

void DebuggerAdapter::setEngineDebugger(std::shared_ptr<IEngineDebugger> debugger) {
  engineDebugger_ = debugger ? debugger : std::make_shared<StubEngineDebugger>();
}

// ============================================
// CDP Method Handlers
// ============================================

CDPResponse DebuggerAdapter::handleEnable(TenantId tenantId, int requestId) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  
  auto& state = tenantStates_[tenantId];
  if (!state.enabled) {
    state.enabled = engineDebugger_->enable(tenantId);
    
    // Send scriptParsed events for existing scripts
    if (state.enabled) {
      auto scripts = engineDebugger_->getScripts(tenantId);
      for (const auto& script : scripts) {
        onScriptParsed(tenantId, script);
      }
    }
  }

  // Replay Debugger.paused to a client that enables while the guest is already
  // parked at a pause. Debugger.paused is a one-shot event fired when the guest
  // first stopped, so a client that attaches afterwards (e.g. a DevTools GUI
  // opened after a script parked the guest) would otherwise see an empty Call
  // Stack and no paused banner even though the guest is stopped. The pause
  // scope is still live, so the frames (and their objectIds) resolve. Reason
  // and hit breakpoints are not retained across the enable, so replay as
  // "other" with no hits — enough for the GUI to render the paused state.
  //
  // Known bounded limitation: onPaused() fans out through the target's
  // broadcast sink, so if two debug clients share one tenant target, a client
  // that was already attached (and already saw the original paused) receives a
  // duplicate paused with no intervening resumed. This only surfaces with 2+
  // concurrent clients on a single tenant — a topology the adapter does not
  // otherwise fully support anyway (enabled state is per-tenant, so a second
  // client gets no scriptParsed replay either). Standard frontends re-render
  // the same paused state idempotently. If multi-client-per-tenant ever becomes
  // supported, move this replay to the target layer and send it only to the
  // enabling connection's sink instead of broadcasting.
  if (state.enabled && engineDebugger_->isPaused(tenantId)) {
    onPaused(tenantId, PauseReason::Other, engineDebugger_->getCallFrames(tenantId), {});
  }
  
  CDPResponse response;
  response.id = requestId;
  response.result = R"({"debuggerId":"rill-debugger"})";
  return response;
}

CDPResponse DebuggerAdapter::handleDisable(TenantId tenantId, int requestId) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  
  auto it = tenantStates_.find(tenantId);
  if (it != tenantStates_.end() && it->second.enabled) {
    engineDebugger_->disable(tenantId);
    it->second.enabled = false;
    it->second.breakpoints.clear();
  }
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleSetBreakpointByUrl(TenantId tenantId, int requestId,
                                                       const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto lineNumber = cdp::parseJSONInt(params, "lineNumber");
  auto url = cdp::parseJSONString(params, "url");
  auto urlRegex = cdp::parseJSONString(params, "urlRegex");
  auto condition = cdp::parseJSONString(params, "condition");
  
  if (!lineNumber) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing lineNumber");
    return response;
  }
  
  int columnNumber = 0;
  auto colOpt = cdp::parseJSONInt(params, "columnNumber");
  if (colOpt) columnNumber = *colOpt;
  
  // Find matching script
  std::string scriptId;
  auto scripts = engineDebugger_->getScripts(tenantId);
  for (const auto& script : scripts) {
    if ((url && script.url == *url) ||
        (urlRegex && script.url.find(*urlRegex) != std::string::npos)) {
      scriptId = script.scriptId;
      break;
    }
  }
  
  if (scriptId.empty() && !scripts.empty()) {
    scriptId = scripts[0].scriptId;  // Default to first script
  }
  
  // Set breakpoint
  std::string breakpointId = generateBreakpointId();
  auto result = engineDebugger_->setBreakpoint(
      tenantId, scriptId, *lineNumber, columnNumber,
      condition.value_or(""));
  
  if (result) {
    if (!result->empty()) breakpointId = *result;  // engine-authoritative id
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto& state = tenantStates_[tenantId];

    BreakpointInfo bp;
    bp.breakpointId = breakpointId;
    bp.scriptId = scriptId;
    bp.lineNumber = *lineNumber;
    bp.columnNumber = columnNumber;
    bp.condition = condition.value_or("");
    bp.enabled = true;
    
    state.breakpoints[breakpointId] = bp;
    
    std::ostringstream ss;
    ss << "{\"breakpointId\":\"" << breakpointId << "\"";
    ss << ",\"locations\":[{";
    ss << "\"scriptId\":\"" << scriptId << "\"";
    ss << ",\"lineNumber\":" << *lineNumber;
    ss << ",\"columnNumber\":" << columnNumber;
    ss << "}]}";
    
    response.result = ss.str();
  } else {
    response.result = R"({"breakpointId":"","locations":[]})";
  }
  
  return response;
}

CDPResponse DebuggerAdapter::handleSetBreakpoint(TenantId tenantId, int requestId,
                                                  const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto scriptId = cdp::parseJSONString(params, "scriptId");
  auto lineNumber = cdp::parseJSONInt(params, "lineNumber");
  
  if (!scriptId || !lineNumber) {
    // Try alternate parsing
    // location: { scriptId: "...", lineNumber: N }
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing location.scriptId or location.lineNumber");
    return response;
  }
  
  int columnNumber = 0;
  auto colOpt = cdp::parseJSONInt(params, "columnNumber");
  if (colOpt) columnNumber = *colOpt;
  
  auto condition = cdp::parseJSONString(params, "condition");
  
  std::string breakpointId = generateBreakpointId();
  auto result = engineDebugger_->setBreakpoint(
      tenantId, *scriptId, *lineNumber, columnNumber,
      condition.value_or(""));
  
  if (result) {
    if (!result->empty()) breakpointId = *result;  // engine-authoritative id
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto& state = tenantStates_[tenantId];

    BreakpointInfo bp;
    bp.breakpointId = breakpointId;
    bp.scriptId = *scriptId;
    bp.lineNumber = *lineNumber;
    bp.columnNumber = columnNumber;
    bp.condition = condition.value_or("");
    bp.enabled = true;
    
    state.breakpoints[breakpointId] = bp;
    
    std::ostringstream ss;
    ss << "{\"breakpointId\":\"" << breakpointId << "\"";
    ss << ",\"actualLocation\":{";
    ss << "\"scriptId\":\"" << *scriptId << "\"";
    ss << ",\"lineNumber\":" << *lineNumber;
    ss << ",\"columnNumber\":" << columnNumber;
    ss << "}}";
    
    response.result = ss.str();
  } else {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INTERNAL_ERROR,
                                         "Failed to set breakpoint");
  }
  
  return response;
}

CDPResponse DebuggerAdapter::handleRemoveBreakpoint(TenantId tenantId, int requestId,
                                                     const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto breakpointId = cdp::parseJSONString(params, "breakpointId");
  if (!breakpointId) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing breakpointId");
    return response;
  }
  
  engineDebugger_->removeBreakpoint(tenantId, *breakpointId);
  
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it != tenantStates_.end()) {
      it->second.breakpoints.erase(*breakpointId);
    }
  }
  
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handlePause(TenantId tenantId, int requestId) {
  engineDebugger_->pause(tenantId);
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleResume(TenantId tenantId, int requestId) {
  // Emit Debugger.resumed before unblocking the engine so a front-end can clear
  // its paused UI state; resume() carries no subsequent paused event.
  onResumed(tenantId);
  engineDebugger_->resume(tenantId);

  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleStepOver(TenantId tenantId, int requestId) {
  // A step resumes, then re-pauses at the next stop. Emit resumed first so it
  // always precedes the Debugger.paused the engine delivers on step completion.
  onResumed(tenantId);
  engineDebugger_->step(tenantId, StepAction::StepOver);

  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleStepInto(TenantId tenantId, int requestId) {
  onResumed(tenantId);
  engineDebugger_->step(tenantId, StepAction::StepInto);

  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleStepOut(TenantId tenantId, int requestId) {
  onResumed(tenantId);
  engineDebugger_->step(tenantId, StepAction::StepOut);

  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DebuggerAdapter::handleEvaluateOnCallFrame(TenantId tenantId, int requestId,
                                                        const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto callFrameId = cdp::parseJSONString(params, "callFrameId");
  auto expression = cdp::parseJSONString(params, "expression");
  
  if (!callFrameId || !expression) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing callFrameId or expression");
    return response;
  }
  
  std::string resultJSON = engineDebugger_->evaluateOnCallFrame(
      tenantId, *callFrameId, *expression);
  
  response.result = "{\"result\":" + resultJSON + "}";
  return response;
}

CDPResponse DebuggerAdapter::handleGetScriptSource(TenantId tenantId, int requestId,
                                                    const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto scriptId = cdp::parseJSONString(params, "scriptId");
  if (!scriptId) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing scriptId");
    return response;
  }
  
  std::string source = engineDebugger_->getScriptSource(tenantId, *scriptId);
  
  std::ostringstream ss;
  ss << "{\"scriptSource\":\"" << cdp::escapeJSON(source) << "\"}";
  response.result = ss.str();
  
  return response;
}

CDPResponse DebuggerAdapter::handleGetProperties(TenantId tenantId, int requestId,
                                                  const std::string& params) {
  CDPResponse response;
  response.id = requestId;

  auto objectId = cdp::parseJSONString(params, "objectId");
  if (!objectId) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing objectId parameter");
    return response;
  }

  // The engine returns the full CDP payload {"result":[...]} already (unlike
  // evaluateOnCallFrame, whose engine result is a bare RemoteObject).
  response.result = engineDebugger_->getProperties(tenantId, *objectId);
  return response;
}

CDPResponse DebuggerAdapter::handleSetPauseOnExceptions(TenantId tenantId, int requestId,
                                                         const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto state = cdp::parseJSONString(params, "state");
  if (!state) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing state parameter");
    return response;
  }
  
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    tenantStates_[tenantId].pauseOnExceptions = *state;
  }
  
  response.result = "{}";
  return response;
}

// ============================================
// Event Emitters
// ============================================

void DebuggerAdapter::onPaused(TenantId tenantId, PauseReason reason,
                                const std::vector<CallFrame>& callFrames,
                                const std::vector<std::string>& hitBreakpoints) {
  CDPEvent event;
  event.method = "Debugger.paused";
  
  std::ostringstream params;
  params << "{";
  
  // Call frames
  params << "\"callFrames\":[";
  for (size_t i = 0; i < callFrames.size(); ++i) {
    if (i > 0) params << ",";
    params << callFrameToJSON(callFrames[i]);
  }
  params << "]";
  
  // Reason
  params << ",\"reason\":\"" << pauseReasonToString(reason) << "\"";
  
  // Hit breakpoints
  if (!hitBreakpoints.empty()) {
    params << ",\"hitBreakpoints\":[";
    for (size_t i = 0; i < hitBreakpoints.size(); ++i) {
      if (i > 0) params << ",";
      params << "\"" << cdp::escapeJSON(hitBreakpoints[i]) << "\"";
    }
    params << "]";
  }
  
  params << "}";
  event.params = params.str();
  
  emitEvent(event);
}

void DebuggerAdapter::onResumed(TenantId tenantId) {
  CDPEvent event;
  event.method = "Debugger.resumed";
  event.params = "{}";
  emitEvent(event);
}

void DebuggerAdapter::onScriptParsed(TenantId tenantId, const ScriptInfo& script) {
  CDPEvent event;
  event.method = "Debugger.scriptParsed";
  event.params = scriptInfoToJSON(script);
  emitEvent(event);
}

void DebuggerAdapter::onScriptFailedToParse(TenantId tenantId, const ScriptInfo& script,
                                             const std::string& errorMessage) {
  CDPEvent event;
  event.method = "Debugger.scriptFailedToParse";
  
  std::ostringstream params;
  params << scriptInfoToJSON(script);
  // Insert error before closing brace
  std::string json = params.str();
  json.pop_back();  // Remove }
  json += ",\"errorMessage\":\"" + cdp::escapeJSON(errorMessage) + "\"}";
  
  event.params = json;
  emitEvent(event);
}

// ============================================
// Private Methods
// ============================================

std::string DebuggerAdapter::callFrameToJSON(const CallFrame& frame) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"callFrameId\":\"" << cdp::escapeJSON(frame.callFrameId) << "\"";
  ss << ",\"functionName\":\"" << cdp::escapeJSON(frame.functionName) << "\"";
  
  // Location
  ss << ",\"location\":{";
  ss << "\"scriptId\":\"" << cdp::escapeJSON(frame.scriptId) << "\"";
  ss << ",\"lineNumber\":" << frame.lineNumber;
  ss << ",\"columnNumber\":" << frame.columnNumber;
  ss << "}";
  
  // URL
  ss << ",\"url\":\"" << cdp::escapeJSON(frame.url) << "\"";
  
  // Scope chain
  ss << ",\"scopeChain\":[";
  for (size_t i = 0; i < frame.scopeChain.size(); ++i) {
    if (i > 0) ss << ",";
    const auto& scope = frame.scopeChain[i];
    ss << "{";
    ss << "\"type\":\"" << scope.type << "\"";
    ss << ",\"object\":{\"type\":\"object\",\"objectId\":\"" 
       << cdp::escapeJSON(scope.objectId) << "\"}";
    if (!scope.name.empty()) {
      ss << ",\"name\":\"" << cdp::escapeJSON(scope.name) << "\"";
    }
    ss << "}";
  }
  ss << "]";
  
  // this
  ss << ",\"this\":{\"type\":\"object\"";
  if (!frame.thisObjectId.empty()) {
    ss << ",\"objectId\":\"" << cdp::escapeJSON(frame.thisObjectId) << "\"";
  }
  ss << "}";
  
  ss << "}";
  return ss.str();
}

std::string DebuggerAdapter::scriptInfoToJSON(const ScriptInfo& script) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"scriptId\":\"" << cdp::escapeJSON(script.scriptId) << "\"";
  ss << ",\"url\":\"" << cdp::escapeJSON(script.url) << "\"";
  ss << ",\"startLine\":" << script.startLine;
  ss << ",\"startColumn\":" << script.startColumn;
  ss << ",\"endLine\":" << script.endLine;
  ss << ",\"endColumn\":" << script.endColumn;
  ss << ",\"executionContextId\":0";
  ss << ",\"hash\":\"" << cdp::escapeJSON(script.hash) << "\"";
  
  if (!script.sourceMapURL.empty()) {
    ss << ",\"sourceMapURL\":\"" << cdp::escapeJSON(script.sourceMapURL) << "\"";
  }
  
  ss << ",\"hasSourceURL\":" << (script.hasSourceURL ? "true" : "false");
  ss << "}";
  return ss.str();
}

std::string DebuggerAdapter::generateBreakpointId() {
  uint64_t id = nextBreakpointId_.fetch_add(1);
  return "bp-" + std::to_string(id);
}

} // namespace rill::devtools
#endif // RILL_WIP_CDP_DEVTOOLS
