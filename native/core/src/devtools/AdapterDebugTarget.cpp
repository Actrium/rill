#include "AdapterDebugTarget.h"

#include "DebuggerAdapter.h"

#include <string>

namespace rill::devtools {

namespace {

// Extract the "params" object substring from a raw CDP request (brace-matched,
// string-aware, mirroring CDPServer::parseRequest). Returns "{}" if absent —
// DebuggerAdapter handlers key-search their params, so an empty object is safe
// for the no-param methods.
std::string extractParams(const std::string& raw) {
  size_t p = raw.find("\"params\"");
  if (p == std::string::npos) return "{}";
  size_t objStart = raw.find('{', p);
  if (objStart == std::string::npos) return "{}";
  int depth = 1;
  size_t i = objStart + 1;
  bool inString = false;
  while (i < raw.size() && depth > 0) {
    char ch = raw[i];
    if (inString) {
      if (ch == '\\' && i + 1 < raw.size()) {
        i += 2;
        continue;
      }
      if (ch == '"') inString = false;
    } else {
      if (ch == '"') inString = true;
      else if (ch == '{') depth++;
      else if (ch == '}') depth--;
    }
    i++;
  }
  return depth == 0 ? raw.substr(objStart, i - objStart) : "{}";
}

std::string responseToRawCdp(const CDPResponse& r) {
  if (r.isError()) return *r.error;
  return cdp::buildResponseJSON(r.id, r.result);
}

}  // namespace

AdapterDebugTarget::AdapterDebugTarget(std::shared_ptr<DebuggerAdapter> adapter,
                                       TenantId tenantId)
    : adapter_(std::move(adapter)), tenantId_(tenantId) {}

DomainSet AdapterDebugTarget::ownedDomains() const {
  DomainSet d;
  d.debugger = true;  // Runtime stays on the local RuntimeAdapter.
  return d;
}

void AdapterDebugTarget::onClientConnect(ConnectionId conn, CdpOutboundFn persistentSink) {
  std::lock_guard<std::mutex> lock(sinksMutex_);
  sinks_[conn] = std::move(persistentSink);
}

void AdapterDebugTarget::onClientDisconnect(ConnectionId conn) {
  std::lock_guard<std::mutex> lock(sinksMutex_);
  sinks_.erase(conn);
}

void AdapterDebugTarget::dispatch(ConnectionId conn, const RawCdpMessage& raw) {
  CdpOutboundFn out;
  {
    std::lock_guard<std::mutex> lock(sinksMutex_);
    auto it = sinks_.find(conn);
    if (it == sinks_.end()) return;  // no client sink installed; nothing to reply to
    out = it->second;
  }

  int id = cdp::parseJSONInt(raw, "id").value_or(0);
  auto methodOpt = cdp::parseJSONString(raw, "method");
  if (!methodOpt) return;
  const std::string& method = *methodOpt;
  size_t dot = method.find('.');
  const std::string m = (dot == std::string::npos) ? method : method.substr(dot + 1);
  const std::string params = extractParams(raw);

  CDPResponse r;
  bool handled = true;
  if (m == "enable") r = adapter_->handleEnable(tenantId_, id);
  else if (m == "disable") r = adapter_->handleDisable(tenantId_, id);
  else if (m == "setBreakpointByUrl") r = adapter_->handleSetBreakpointByUrl(tenantId_, id, params);
  else if (m == "setBreakpoint") r = adapter_->handleSetBreakpoint(tenantId_, id, params);
  else if (m == "removeBreakpoint") r = adapter_->handleRemoveBreakpoint(tenantId_, id, params);
  else if (m == "pause") r = adapter_->handlePause(tenantId_, id);
  else if (m == "resume") r = adapter_->handleResume(tenantId_, id);
  else if (m == "stepOver") r = adapter_->handleStepOver(tenantId_, id);
  else if (m == "stepInto") r = adapter_->handleStepInto(tenantId_, id);
  else if (m == "stepOut") r = adapter_->handleStepOut(tenantId_, id);
  else if (m == "evaluateOnCallFrame") r = adapter_->handleEvaluateOnCallFrame(tenantId_, id, params);
  else if (m == "getScriptSource") r = adapter_->handleGetScriptSource(tenantId_, id, params);
  else if (m == "setPauseOnExceptions") r = adapter_->handleSetPauseOnExceptions(tenantId_, id, params);
  else handled = false;

  if (handled) {
    out(responseToRawCdp(r));
  } else {
    out(cdp::buildErrorJSON(id, CDPErrorCode::METHOD_NOT_FOUND,
                            "Unknown Debugger method: " + method));
  }
}

}  // namespace rill::devtools
