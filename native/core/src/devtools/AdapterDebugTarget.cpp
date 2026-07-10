#include "AdapterDebugTarget.h"

#include "DebuggerAdapter.h"

#include <string>
#include <vector>

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
    : adapter_(std::move(adapter)), tenantId_(tenantId) {
  // Route the adapter's async events (Debugger.paused/resumed/scriptParsed/...)
  // out through this target's per-connection sinks — the same path as command
  // responses, so events and responses stay consistent.
  if (adapter_) {
    adapter_->setEventSink([this](const std::string& json) { broadcast(json); });
  }
}

AdapterDebugTarget::~AdapterDebugTarget() {
  // Drop the sink before this object dies so a late event can't call broadcast()
  // on a destroyed target.
  if (adapter_) adapter_->setEventSink(nullptr);
}

void AdapterDebugTarget::broadcast(const std::string& rawEventJson) {
  std::vector<CdpOutboundFn> targets;
  {
    std::lock_guard<std::mutex> lock(sinksMutex_);
    targets.reserve(sinks_.size());
    for (const auto& [conn, sink] : sinks_) targets.push_back(sink);
  }
  for (const auto& sink : targets) sink(rawEventJson);
}

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
  const std::string domain = (dot == std::string::npos) ? std::string() : method.substr(0, dot);
  const std::string m = (dot == std::string::npos) ? method : method.substr(dot + 1);
  const std::string params = extractParams(raw);

  CDPResponse r;
  bool handled = true;
  if (domain == "Runtime") {
    // Runtime is owned by RuntimeAdapter on the multi-target native path, so this
    // branch is reached only where this target also fronts Runtime for a single
    // engine (the fat CDP wasm). Scope/object expansion goes to the engine; the
    // frontend's attach handshake (enable/runIfWaitingForDebugger) is acked so a
    // GUI can drive the guest without a separate Runtime adapter.
    if (m == "getProperties") r = adapter_->handleGetProperties(tenantId_, id, params);
    else if (m == "enable" || m == "disable" || m == "runIfWaitingForDebugger") {
      r.id = id;
      r.result = "{}";
    }
    else handled = false;
  } else {
    // Debugger domain (the target's owned domain).
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
  }

  if (handled) {
    out(responseToRawCdp(r));
  } else {
    out(cdp::buildErrorJSON(id, CDPErrorCode::METHOD_NOT_FOUND,
                            "Unknown method: " + method));
  }
}

}  // namespace rill::devtools
