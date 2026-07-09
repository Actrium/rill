// WIP subsystem — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in devtools/CDPServer.h.
#if RILL_WIP_CDP_DEVTOOLS
/**
 * NetworkAdapter.cpp
 *
 * P3-Y.7: Network Domain Adapter Implementation
 */

#include "NetworkAdapter.h"
#include <sstream>
#include <iomanip>

namespace rill::devtools {

NetworkAdapter::NetworkAdapter(CDPServer& server)
    : server_(server) {}

// ============================================
// CDP Method Handlers
// ============================================

CDPResponse NetworkAdapter::handleEnable(TenantId tenantId, int requestId,
                                          const std::string& /*params*/) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  tenantStates_[tenantId].enabled = true;
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse NetworkAdapter::handleDisable(TenantId tenantId, int requestId) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  
  auto it = tenantStates_.find(tenantId);
  if (it != tenantStates_.end()) {
    it->second.enabled = false;
    it->second.responseBodies.clear();
  }
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse NetworkAdapter::handleGetResponseBody(TenantId tenantId, int requestId,
                                                   const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto reqId = cdp::parseJSONString(params, "requestId");
  if (!reqId) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing requestId");
    return response;
  }
  
  std::lock_guard<std::mutex> lock(stateMutex_);
  auto stateIt = tenantStates_.find(tenantId);
  if (stateIt == tenantStates_.end()) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INTERNAL_ERROR,
                                         "Tenant not found");
    return response;
  }
  
  auto bodyIt = stateIt->second.responseBodies.find(*reqId);
  if (bodyIt == stateIt->second.responseBodies.end()) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INTERNAL_ERROR,
                                         "Response body not found");
    return response;
  }
  
  std::ostringstream ss;
  ss << "{\"body\":\"" << cdp::escapeJSON(bodyIt->second.body) << "\"";
  ss << ",\"base64Encoded\":" << (bodyIt->second.base64Encoded ? "true" : "false");
  ss << "}";
  
  response.result = ss.str();
  return response;
}

CDPResponse NetworkAdapter::handleSetCacheDisabled(TenantId tenantId, int requestId,
                                                    const std::string& params) {
  auto cacheDisabled = cdp::parseJSONString(params, "cacheDisabled");
  
  std::lock_guard<std::mutex> lock(stateMutex_);
  tenantStates_[tenantId].cacheDisabled = (cacheDisabled && *cacheDisabled == "true");
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse NetworkAdapter::handleSetExtraHTTPHeaders(TenantId /*tenantId*/, int requestId,
                                                       const std::string& /*params*/) {
  // Parse headers from params - simplified parsing
  // In real implementation, would properly parse the headers object
  
  std::lock_guard<std::mutex> lock(stateMutex_);
  // tenantStates_[tenantId].extraHeaders = parsedHeaders;
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse NetworkAdapter::handleGetCookies(TenantId /*tenantId*/, int requestId) {
  // Sandbox doesn't support cookies - return empty
  CDPResponse response;
  response.id = requestId;
  response.result = R"({"cookies":[]})";
  return response;
}

CDPResponse NetworkAdapter::handleClearBrowserCache(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse NetworkAdapter::handleClearBrowserCookies(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

// ============================================
// Event Emitters
// ============================================

void NetworkAdapter::onRequestWillBeSent(TenantId tenantId, const NetworkRequest& request,
                                          ResourceType type,
                                          const RequestInitiator& initiator) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.requestWillBeSent";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(request.requestId) << "\"";
  params << ",\"loaderId\":\"" << tenantId << "\"";
  params << ",\"documentURL\":\"" << cdp::escapeJSON(request.url) << "\"";
  params << ",\"request\":" << requestToJSON(request);
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << request.timestamp;
  params << ",\"wallTime\":" << std::fixed << std::setprecision(6) << request.wallTime;
  params << ",\"initiator\":" << initiatorToJSON(initiator);
  params << ",\"type\":\"" << resourceTypeToString(type) << "\"";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onResponseReceived(TenantId tenantId, const NetworkResponse& response,
                                         ResourceType type) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.responseReceived";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(response.requestId) << "\"";
  params << ",\"loaderId\":\"" << tenantId << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << response.timestamp;
  params << ",\"type\":\"" << resourceTypeToString(type) << "\"";
  params << ",\"response\":" << responseToJSON(response);
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onDataReceived(TenantId tenantId, const std::string& requestId,
                                     int64_t dataLength, int64_t encodedDataLength) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.dataReceived";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << getCurrentTimestamp();
  params << ",\"dataLength\":" << dataLength;
  params << ",\"encodedDataLength\":" << encodedDataLength;
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onLoadingFinished(TenantId tenantId, const std::string& requestId,
                                        double timestamp, int64_t encodedDataLength) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.loadingFinished";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << timestamp;
  params << ",\"encodedDataLength\":" << encodedDataLength;
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onLoadingFailed(TenantId tenantId, const NetworkError& error) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.loadingFailed";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(error.requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << error.timestamp;
  params << ",\"type\":\"Fetch\"";
  params << ",\"errorText\":\"" << cdp::escapeJSON(error.errorText) << "\"";
  params << ",\"canceled\":" << (error.canceled ? "true" : "false");
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onRequestBlocked(TenantId tenantId, const BlockedRequest& blocked) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.requestWillBeSentExtraInfo";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(blocked.requestId) << "\"";
  params << ",\"blockedCookies\":[]";
  params << ",\"headers\":{}";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
  
  // Also send loadingFailed
  NetworkError error;
  error.requestId = blocked.requestId;
  error.errorText = "net::ERR_BLOCKED_BY_RESPONSE (" + blocked.blockedReason + ")";
  error.timestamp = blocked.timestamp;
  onLoadingFailed(tenantId, error);
}

// ============================================
// WebSocket Events
// ============================================

void NetworkAdapter::onWebSocketCreated(TenantId tenantId, const std::string& requestId,
                                         const std::string& url) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.webSocketCreated";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"url\":\"" << cdp::escapeJSON(url) << "\"";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onWebSocketClosed(TenantId tenantId, const std::string& requestId) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.webSocketClosed";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << getCurrentTimestamp();
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onWebSocketFrameSent(TenantId tenantId, const std::string& requestId,
                                           const std::string& data, bool isBinary) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.webSocketFrameSent";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << getCurrentTimestamp();
  params << ",\"response\":{";
  params << "\"opcode\":" << (isBinary ? 2 : 1);
  params << ",\"mask\":true";
  params << ",\"payloadData\":\"" << cdp::escapeJSON(data) << "\"";
  params << "}}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void NetworkAdapter::onWebSocketFrameReceived(TenantId tenantId, const std::string& requestId,
                                               const std::string& data, bool isBinary) {
  {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto it = tenantStates_.find(tenantId);
    if (it == tenantStates_.end() || !it->second.enabled) {
      return;
    }
  }
  
  CDPEvent event;
  event.method = "Network.webSocketFrameReceived";
  
  std::ostringstream params;
  params << "{";
  params << "\"requestId\":\"" << cdp::escapeJSON(requestId) << "\"";
  params << ",\"timestamp\":" << std::fixed << std::setprecision(6) << getCurrentTimestamp();
  params << ",\"response\":{";
  params << "\"opcode\":" << (isBinary ? 2 : 1);
  params << ",\"mask\":false";
  params << ",\"payloadData\":\"" << cdp::escapeJSON(data) << "\"";
  params << "}}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

// ============================================
// Response Body Storage
// ============================================

void NetworkAdapter::storeResponseBody(TenantId tenantId, const std::string& requestId,
                                        const std::string& body, bool base64Encoded) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  
  auto& state = tenantStates_[tenantId];
  state.responseBodies[requestId] = {body, base64Encoded};
  
  // Limit stored responses (simple LRU: remove oldest if too many)
  const size_t maxResponses = 100;
  while (state.responseBodies.size() > maxResponses) {
    state.responseBodies.erase(state.responseBodies.begin());
  }
}

void NetworkAdapter::clearResponseBodies(TenantId tenantId) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  
  auto it = tenantStates_.find(tenantId);
  if (it != tenantStates_.end()) {
    it->second.responseBodies.clear();
  }
}

// ============================================
// Private Methods
// ============================================

std::string NetworkAdapter::requestToJSON(const NetworkRequest& request) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"url\":\"" << cdp::escapeJSON(request.url) << "\"";
  ss << ",\"method\":\"" << cdp::escapeJSON(request.method) << "\"";
  ss << ",\"headers\":" << headersToJSON(request.headers);
  
  if (request.hasPostData) {
    ss << ",\"hasPostData\":true";
    ss << ",\"postData\":\"" << cdp::escapeJSON(request.postData) << "\"";
  }
  
  ss << "}";
  return ss.str();
}

std::string NetworkAdapter::responseToJSON(const NetworkResponse& response) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"url\":\"" << cdp::escapeJSON(response.url) << "\"";
  ss << ",\"status\":" << response.status;
  ss << ",\"statusText\":\"" << cdp::escapeJSON(response.statusText) << "\"";
  ss << ",\"headers\":" << headersToJSON(response.headers);
  ss << ",\"mimeType\":\"" << cdp::escapeJSON(response.mimeType) << "\"";
  ss << ",\"connectionReused\":false";
  ss << ",\"connectionId\":0";
  ss << ",\"encodedDataLength\":" << response.encodedDataLength;
  ss << ",\"securityState\":\"neutral\"";
  ss << "}";
  return ss.str();
}

std::string NetworkAdapter::initiatorToJSON(const RequestInitiator& initiator) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"type\":\"" << cdp::escapeJSON(initiator.type) << "\"";
  
  if (!initiator.url.empty()) {
    ss << ",\"url\":\"" << cdp::escapeJSON(initiator.url) << "\"";
    ss << ",\"lineNumber\":" << initiator.lineNumber;
    ss << ",\"columnNumber\":" << initiator.columnNumber;
  }
  
  if (!initiator.stack.empty()) {
    ss << ",\"stack\":" << initiator.stack;
  }
  
  ss << "}";
  return ss.str();
}

std::string NetworkAdapter::headersToJSON(
    const std::unordered_map<std::string, std::string>& headers) {
  std::ostringstream ss;
  ss << "{";
  
  bool first = true;
  for (const auto& [key, value] : headers) {
    if (!first) ss << ",";
    first = false;
    ss << "\"" << cdp::escapeJSON(key) << "\":\"" << cdp::escapeJSON(value) << "\"";
  }
  
  ss << "}";
  return ss.str();
}

double NetworkAdapter::getCurrentTimestamp() {
  auto now = std::chrono::system_clock::now();
  auto duration = now.time_since_epoch();
  return std::chrono::duration<double>(duration).count();
}

std::string NetworkAdapter::generateRequestId() {
  uint64_t id = nextRequestId_.fetch_add(1);
  return "req-" + std::to_string(id);
}

} // namespace rill::devtools
#endif // RILL_WIP_CDP_DEVTOOLS
