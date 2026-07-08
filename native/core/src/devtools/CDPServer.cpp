/**
 * CDPServer.cpp
 *
 * P3-Y.1: Chrome DevTools Protocol Server Implementation
 *
 * This implementation provides:
 *   - CDP message parsing and routing
 *   - Session management
 *   - Target list for /json endpoint
 *
 * Note: The actual WebSocket transport is platform-specific and
 * will be implemented in CDPServer.mm (Apple) or CDPServer_android.cpp.
 * This file contains platform-independent logic.
 */

#include "CDPServer.h"
#include "EngineDebugTarget.h"

#include <chrono>
#include <climits>
#include <sstream>
#include <algorithm>
#include <random>
#include <iomanip>

namespace rill::devtools {

// ============================================
// CDPTarget Implementation
// ============================================

std::string CDPTarget::toJSON() const {
  std::ostringstream ss;
  ss << "{";
  ss << "\"id\":\"" << cdp::escapeJSON(id) << "\",";
  ss << "\"type\":\"" << cdp::escapeJSON(type) << "\",";
  ss << "\"title\":\"" << cdp::escapeJSON(title) << "\",";
  ss << "\"url\":\"" << cdp::escapeJSON(url) << "\",";
  ss << "\"webSocketDebuggerUrl\":\"" << cdp::escapeJSON(webSocketDebuggerUrl) << "\"";
  if (!devtoolsFrontendUrl.empty()) {
    ss << ",\"devtoolsFrontendUrl\":\"" << cdp::escapeJSON(devtoolsFrontendUrl) << "\"";
  }
  if (!faviconUrl.empty()) {
    ss << ",\"faviconUrl\":\"" << cdp::escapeJSON(faviconUrl) << "\"";
  }
  ss << "}";
  return ss.str();
}

// ============================================
// CDPServer Implementation
// ============================================

CDPServer::CDPServer(CDPServerConfig config)
    : config_(std::move(config)) {
  // Platform-specific impl will be created in start()
}

CDPServer::~CDPServer() {
  stop();
}

bool CDPServer::start() {
  if (running_.load()) {
    return true; // Already running
  }

  if (!config_.enabled) {
    return false;
  }

  // If a transport is provided, wire up callbacks and start it
  if (config_.transport) {
    config_.transport->setOnMessage(
        [this](ConnectionId connId, const std::string& msg) {
          handleMessage(connId, msg);
        });
    config_.transport->setOnConnect(
        [this](ConnectionId connId, const std::string& path) {
          std::lock_guard<std::mutex> lock(mutex_);
          Connection conn;
          conn.id = connId;
          conn.connectedAt = currentTimeMs();
          connections_[connId] = std::move(conn);
          // Bind the connection to a tenant from its "/tenant/{id}" path, so
          // relay and events route to the right guest without a per-request
          // sessionId.
          if (auto tenantId = parseTenantFromPath(path)) {
            connectionTenant_[connId] = *tenantId;
          }
        });
    config_.transport->setOnDisconnect(
        [this](ConnectionId connId) {
          std::lock_guard<std::mutex> lock(mutex_);
          auto it = connectionToSession_.find(connId);
          if (it != connectionToSession_.end()) {
            sessions_.erase(it->second);
            connectionToSession_.erase(it);
          }
          connectionTenant_.erase(connId);
          connections_.erase(connId);
        });

    if (!config_.transport->start(config_.host, config_.port)) {
      return false;
    }
  }

  // Mark as running
  running_.store(true);
  return true;
}

void CDPServer::stop() {
  if (!running_.load()) {
    return;
  }
  
  running_.store(false);

  // Stop transport if present
  if (config_.transport) {
    config_.transport->stop();
  }

  // Close all sessions
  {
    std::lock_guard<std::mutex> lock(mutex_);
    sessions_.clear();
    connectionToSession_.clear();
    connections_.clear();
  }

  if (serverThread_ && serverThread_->joinable()) {
    serverThread_->join();
  }
  serverThread_.reset();
}

bool CDPServer::isRunning() const {
  return running_.load();
}

// ============================================
// Tenant Management
// ============================================

void CDPServer::registerTenant(TenantId id, const std::string& title, const std::string& url) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  TenantInfo info;
  info.id = id;
  info.title = title;
  info.url = url.empty() ? ("rill://tenant/" + std::to_string(id)) : url;
  info.registeredAt = currentTimeMs();
  
  tenants_[id] = std::move(info);
}

void CDPServer::registerDebugTarget(TenantId id, std::shared_ptr<IEngineDebugTarget> target) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (target) {
    tenantTargets_[id] = std::move(target);
  } else {
    tenantTargets_.erase(id);
  }
}

void CDPServer::unregisterDebugTarget(TenantId id) {
  std::lock_guard<std::mutex> lock(mutex_);
  tenantTargets_.erase(id);
}

void CDPServer::unregisterTenant(TenantId id) {
  std::lock_guard<std::mutex> lock(mutex_);

  tenants_.erase(id);
  tenantTargets_.erase(id);

  // Close sessions for this tenant
  std::vector<SessionId> sessionsToRemove;
  for (const auto& [sessionId, session] : sessions_) {
    if (session.tenantId == id) {
      sessionsToRemove.push_back(sessionId);
    }
  }
  
  for (const auto& sessionId : sessionsToRemove) {
    auto it = sessions_.find(sessionId);
    if (it != sessions_.end()) {
      connectionToSession_.erase(it->second.connectionId);
      sessions_.erase(it);
    }
  }
}

bool CDPServer::hasTenant(TenantId id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return tenants_.find(id) != tenants_.end();
}

std::vector<TenantId> CDPServer::getTenantIds() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<TenantId> ids;
  ids.reserve(tenants_.size());
  for (const auto& [id, _] : tenants_) {
    ids.push_back(id);
  }
  return ids;
}

// ============================================
// Event Emission
// ============================================

void CDPServer::sendEvent(TenantId tenantId, const CDPEvent& event) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  for (const auto& [sessionId, session] : sessions_) {
    if (session.tenantId == tenantId) {
      std::string json = cdp::buildEventJSON(event.method, event.params, sessionId);
      sendToConnection(session.connectionId, json);
    }
  }
}

void CDPServer::sendEventToSession(const SessionId& sessionId, const CDPEvent& event) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  auto it = sessions_.find(sessionId);
  if (it != sessions_.end()) {
    std::string json = cdp::buildEventJSON(event.method, event.params, sessionId);
    sendToConnection(it->second.connectionId, json);
  }
}

void CDPServer::broadcastEvent(const CDPEvent& event) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  std::string json = cdp::buildEventJSON(event.method, event.params, std::nullopt);
  for (const auto& [connId, _] : connections_) {
    sendToConnection(connId, json);
  }
}

// ============================================
// URL Helpers
// ============================================

std::string CDPServer::getWebSocketUrl(TenantId id) const {
  std::ostringstream ss;
  ss << "ws://" << config_.host << ":" << config_.port << "/tenant/" << id;
  return ss.str();
}

std::string CDPServer::getDevToolsUrl(TenantId id) const {
  std::string wsUrl = getWebSocketUrl(id);
  // URL encode the WebSocket URL for the DevTools frontend
  std::ostringstream ss;
  ss << "devtools://devtools/bundled/inspector.html?ws=";
  ss << config_.host << ":" << config_.port << "/tenant/" << id;
  return ss.str();
}

std::string CDPServer::getTargetListUrl() const {
  std::ostringstream ss;
  ss << "http://" << config_.host << ":" << config_.port << "/json";
  return ss.str();
}

// ============================================
// Statistics
// ============================================

size_t CDPServer::getConnectionCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return connections_.size();
}

size_t CDPServer::getSessionCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return sessions_.size();
}

// ============================================
// Message Handling
// ============================================

void CDPServer::handleMessage(ConnectionId connId, const std::string& message) {
  messagesReceived_.fetch_add(1);

  auto request = parseRequest(message);
  if (!request) {
    CDPResponse error = makeError(0, CDPErrorCode::PARSE_ERROR, "Parse error");
    sendResponse(connId, error);
    return;
  }

  // Domain of this request ("Runtime.evaluate" -> "Runtime"), for the
  // forward-vs-local routing decision below.
  std::string domain;
  {
    size_t dotPos = request->method.find('.');
    if (dotPos != std::string::npos) {
      domain = request->method.substr(0, dotPos);
    }
  }

  // Decide routing under the lock, then act. A domain owned by the tenant's
  // debug target is forwarded verbatim OUTSIDE the lock, so the outbound sink
  // may re-enter the server (sendToConnection) without self-deadlock.
  std::shared_ptr<IEngineDebugTarget> forwardTarget;
  {
    std::lock_guard<std::mutex> lock(mutex_);

    CDPSession* session = getOrCreateSessionLocked(connId, *request);
    if (!session) {
      CDPResponse error = makeError(request->id, CDPErrorCode::SESSION_NOT_FOUND, "Session not found");
      sendResponse(connId, error);
      return;
    }
    session->lastActivityAt = currentTimeMs();

    auto it = tenantTargets_.find(session->tenantId);
    if (it != tenantTargets_.end() && it->second && it->second->ownedDomains().owns(domain)) {
      forwardTarget = it->second;  // forward below, outside the lock
    } else {
      // Local path: the built-in domain handler synthesizes the response.
      CDPResponse response = routeRequest(*request, *session);
      sendResponse(connId, response);
      return;
    }
  }  // mutex_ released

  // Owned domain: forward the raw CDP verbatim. The target is the sole authority
  // — it emits the response and any events through the sink; we synthesize
  // nothing, and outbound bypasses buildEventJSON (the target already speaks CDP).
  forwardTarget->dispatch(message, [this, connId](const RawCdpMessage& out) {
    sendToConnection(connId, out);
  });
}

std::optional<CDPRequest> CDPServer::parseRequest(const std::string& json) {
  CDPRequest request;
  
  // Parse id
  auto id = cdp::parseJSONInt(json, "id");
  if (!id) {
    return std::nullopt;
  }
  request.id = *id;
  
  // Parse method
  auto method = cdp::parseJSONString(json, "method");
  if (!method) {
    return std::nullopt;
  }
  request.method = *method;
  
  // Parse params (optional, extract raw JSON object)
  size_t paramsPos = json.find("\"params\"");
  if (paramsPos != std::string::npos) {
    // Find the object start
    size_t objStart = json.find('{', paramsPos);
    if (objStart != std::string::npos) {
      // String-aware brace counting: skip braces inside quoted strings
      int depth = 1;
      size_t i = objStart + 1;
      bool inString = false;
      while (i < json.size() && depth > 0) {
        char ch = json[i];
        if (inString) {
          if (ch == '\\' && i + 1 < json.size()) {
            i += 2; // skip escaped character
            continue;
          }
          if (ch == '"') {
            inString = false;
          }
        } else {
          if (ch == '"') {
            inString = true;
          } else if (ch == '{') {
            depth++;
          } else if (ch == '}') {
            depth--;
          }
        }
        i++;
      }
      if (depth == 0) {
        request.params = json.substr(objStart, i - objStart);
      }
    }
  }
  if (request.params.empty()) {
    request.params = "{}";
  }
  
  // Parse sessionId (optional)
  auto sessionId = cdp::parseJSONString(json, "sessionId");
  if (sessionId) {
    request.sessionId = *sessionId;
  }
  
  return request;
}

CDPResponse CDPServer::routeRequest(const CDPRequest& request, const CDPSession& session) {
  // Extract domain from method (e.g., "Runtime.evaluate" -> "Runtime")
  std::string domain;
  std::string methodName;
  
  size_t dotPos = request.method.find('.');
  if (dotPos != std::string::npos) {
    domain = request.method.substr(0, dotPos);
    methodName = request.method.substr(dotPos + 1);
  } else {
    return makeError(request.id, CDPErrorCode::METHOD_NOT_FOUND, 
                     "Invalid method format: " + request.method);
  }
  
  // Route to domain handler
  // Note: Cast away const for session since handlers may update state
  CDPSession& mutableSession = const_cast<CDPSession&>(session);
  
  if (domain == "Runtime") {
    return handleRuntimeMethod(request, mutableSession);
  } else if (domain == "Console") {
    return handleConsoleMethod(request, mutableSession);
  } else if (domain == "Debugger") {
    return handleDebuggerMethod(request, mutableSession);
  } else if (domain == "DOM") {
    return handleDOMMethod(request, mutableSession);
  } else if (domain == "Network") {
    return handleNetworkMethod(request, mutableSession);
  } else if (domain == "Profiler") {
    return handleProfilerMethod(request, mutableSession);
  } else if (domain == "Target") {
    return handleTargetMethod(request, mutableSession);
  }
  
  return makeError(request.id, CDPErrorCode::METHOD_NOT_FOUND, 
                   "Unknown domain: " + domain);
}

void CDPServer::sendResponse(ConnectionId connId, const CDPResponse& response) {
  std::string json;
  if (response.isError()) {
    // Parse error code and message from error JSON
    // For now, just send the pre-built error
    json = *response.error;
  } else {
    json = cdp::buildResponseJSON(response.id, response.result);
  }
  
  sendToConnection(connId, json);
}

void CDPServer::sendToConnection(ConnectionId connId, const std::string& json) {
  messagesSent_.fetch_add(1);

  if (config_.transport) {
    config_.transport->send(connId, json);
  }
  // No transport = no-op (unit test mode)
}

// ============================================
// HTTP Handling
// ============================================

std::string CDPServer::handleHttpRequest(const std::string& path) {
  if (path == "/json" || path == "/json/list") {
    return buildTargetListJSON();
  } else if (path == "/json/version") {
    return R"({"Browser":"Rill/1.0","Protocol-Version":"1.3"})";
  } else if (path == "/json/protocol") {
    // Return minimal protocol descriptor
    return R"({"domains":[]})";
  }
  
  // 404 for unknown paths
  return "";
}

std::string CDPServer::buildTargetListJSON() const {
  std::lock_guard<std::mutex> lock(mutex_);
  
  std::ostringstream ss;
  ss << "[";
  
  bool first = true;
  for (const auto& [id, info] : tenants_) {
    if (!first) ss << ",";
    first = false;
    
    CDPTarget target;
    target.id = std::to_string(id);
    target.type = "node";
    target.title = info.title;
    target.url = info.url;
    target.webSocketDebuggerUrl = getWebSocketUrl(id);
    target.devtoolsFrontendUrl = getDevToolsUrl(id);
    
    ss << target.toJSON();
  }
  
  ss << "]";
  return ss.str();
}

// ============================================
// Session Management
// ============================================

SessionId CDPServer::createSession(ConnectionId connId, TenantId tenantId) {
  SessionId sessionId = generateSessionId(tenantId);
  
  CDPSession session;
  session.id = sessionId;
  session.tenantId = tenantId;
  session.connectionId = connId;
  session.createdAt = currentTimeMs();
  session.lastActivityAt = session.createdAt;
  
  sessions_[sessionId] = std::move(session);
  connectionToSession_[connId] = sessionId;
  
  return sessionId;
}

CDPSession* CDPServer::getSession(const SessionId& id) {
  auto it = sessions_.find(id);
  return it != sessions_.end() ? &it->second : nullptr;
}

void CDPServer::removeSession(const SessionId& id) {
  auto it = sessions_.find(id);
  if (it != sessions_.end()) {
    connectionToSession_.erase(it->second.connectionId);
    sessions_.erase(it);
  }
}

CDPSession* CDPServer::getOrCreateSessionLocked(ConnectionId connId, const CDPRequest& request) {
  // Check if connection already has a session
  auto connIt = connectionToSession_.find(connId);
  if (connIt != connectionToSession_.end()) {
    return getSession(connIt->second);
  }
  
  // Prefer the tenant bound at connect time from the "/tenant/{id}" path.
  TenantId tenantId = 0;
  auto ctIt = connectionTenant_.find(connId);
  if (ctIt != connectionTenant_.end()) {
    tenantId = ctIt->second;
  } else if (request.sessionId) {
    // Parse tenant ID from session ID (format: "tenant-{id}-{uuid}")
    const std::string& sid = *request.sessionId;
    size_t dashPos = sid.find('-');
    if (dashPos != std::string::npos && sid.substr(0, dashPos) == "tenant") {
      size_t secondDash = sid.find('-', dashPos + 1);
      if (secondDash != std::string::npos) {
        try {
          tenantId = static_cast<TenantId>(
            std::stoul(sid.substr(dashPos + 1, secondDash - dashPos - 1)));
        } catch (...) {
          // Invalid format, tenantId remains 0
        }
      }
    }
  }
  
  // Create new session
  SessionId newSessionId = createSession(connId, tenantId);
  return getSession(newSessionId);
}

std::optional<TenantId> CDPServer::parseTenantFromPath(const std::string& path) {
  // Match ".../tenant/{digits}", tolerating a leading path and trailing
  // segments/query (e.g. "/tenant/3", "/devtools/tenant/12/page").
  static const std::string kMarker = "/tenant/";
  size_t pos = path.find(kMarker);
  if (pos == std::string::npos) return std::nullopt;
  size_t start = pos + kMarker.size();
  size_t end = start;
  while (end < path.size() && path[end] >= '0' && path[end] <= '9') ++end;
  if (end == start) return std::nullopt;  // no digits after the marker
  try {
    return static_cast<TenantId>(std::stoul(path.substr(start, end - start)));
  } catch (...) {
    return std::nullopt;
  }
}

// ============================================
// Domain Handlers (Stubs for P3-Y.2+)
// ============================================

CDPResponse CDPServer::handleRuntimeMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.runtimeEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.runtimeEnabled = false;
    return makeSuccess(req.id);
  } else if (methodName == "evaluate") {
    // P3-Y.4: RuntimeAdapter will handle this
    if (config_.onEvaluate && session.tenantId != 0) {
      // Extract expression from params
      auto expr = cdp::parseJSONString(req.params, "expression");
      if (expr) {
        std::string result = config_.onEvaluate(session.tenantId, *expr, true);
        return makeSuccess(req.id, "{\"result\":" + result + "}");
      }
    }
    return makeError(req.id, CDPErrorCode::INVALID_PARAMS, "Missing expression");
  }
  
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND, 
                   "Runtime." + methodName + " not implemented");
}

CDPResponse CDPServer::handleConsoleMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.consoleEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.consoleEnabled = false;
    return makeSuccess(req.id);
  } else if (methodName == "clearMessages") {
    return makeSuccess(req.id);
  }
  
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "Console." + methodName + " not implemented");
}

CDPResponse CDPServer::handleDebuggerMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.debuggerEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.debuggerEnabled = false;
    return makeSuccess(req.id);
  }
  
  // P3-Y.6: DebuggerAdapter will handle breakpoints, stepping, etc.
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "Debugger." + methodName + " not implemented");
}

CDPResponse CDPServer::handleDOMMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.domEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.domEnabled = false;
    return makeSuccess(req.id);
  } else if (methodName == "getDocument") {
    // P3-Y.5: DOMAdapter will handle this
    if (config_.onGetComponentTree && session.tenantId != 0) {
      std::string tree = config_.onGetComponentTree(session.tenantId);
      return makeSuccess(req.id, "{\"root\":" + tree + "}");
    }
    return makeSuccess(req.id, R"({"root":{"nodeId":1,"nodeName":"#document","childNodeCount":0}})");
  }
  
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "DOM." + methodName + " not implemented");
}

CDPResponse CDPServer::handleNetworkMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.networkEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.networkEnabled = false;
    return makeSuccess(req.id);
  }
  
  // P3-Y.7: NetworkAdapter will handle this
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "Network." + methodName + " not implemented");
}

CDPResponse CDPServer::handleProfilerMethod(const CDPRequest& req, CDPSession& session) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);
  
  if (methodName == "enable") {
    session.profilerEnabled = true;
    return makeSuccess(req.id);
  } else if (methodName == "disable") {
    session.profilerEnabled = false;
    return makeSuccess(req.id);
  }
  
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "Profiler." + methodName + " not implemented");
}

CDPResponse CDPServer::handleTargetMethod(const CDPRequest& req, CDPSession& /*session*/) {
  std::string methodName = req.method.substr(req.method.find('.') + 1);

  if (methodName == "getTargets") {
    // mutex_ already held by handleMessage caller
    std::ostringstream ss;
    ss << "{\"targetInfos\":[";
    bool first = true;
    for (const auto& [id, info] : tenants_) {
      if (!first) ss << ",";
      first = false;
      ss << "{\"targetId\":\"" << id << "\",";
      ss << "\"type\":\"node\",";
      ss << "\"title\":\"" << cdp::escapeJSON(info.title) << "\",";
      ss << "\"url\":\"" << cdp::escapeJSON(info.url) << "\"}";
    }
    ss << "]}";
    return makeSuccess(req.id, ss.str());
  }
  
  return makeError(req.id, CDPErrorCode::METHOD_NOT_FOUND,
                   "Target." + methodName + " not implemented");
}

// ============================================
// Utility Methods
// ============================================

ConnectionId CDPServer::generateConnectionId() {
  return nextConnectionId_.fetch_add(1);
}

SessionId CDPServer::generateSessionId(TenantId tenantId) {
  // Generate UUID-like suffix (thread_local for thread safety)
  thread_local std::random_device rd;
  thread_local std::mt19937 gen(rd());
  thread_local std::uniform_int_distribution<uint32_t> dis(0, 0xFFFFFFFF);
  
  std::ostringstream ss;
  ss << "tenant-" << tenantId << "-";
  ss << std::hex << std::setfill('0') << std::setw(8) << dis(gen);
  ss << std::setw(8) << dis(gen);
  return ss.str();
}

uint64_t CDPServer::currentTimeMs() {
  auto now = std::chrono::system_clock::now();
  auto duration = now.time_since_epoch();
  return static_cast<uint64_t>(
    std::chrono::duration_cast<std::chrono::milliseconds>(duration).count());
}

CDPResponse CDPServer::makeError(int requestId, int code, const std::string& message) {
  CDPResponse response;
  response.id = requestId;
  response.error = cdp::buildErrorJSON(requestId, code, message);
  return response;
}

CDPResponse CDPServer::makeSuccess(int requestId, const std::string& resultJson) {
  CDPResponse response;
  response.id = requestId;
  response.result = resultJson;
  return response;
}

// ============================================
// CDP JSON Helpers
// ============================================

namespace cdp {

/**
 * Quick validation: params must start with '{' and end with '}'.
 * Not a full JSON parser, but catches obviously malformed input.
 */
static bool looksLikeJSONObject(const std::string& s) {
  if (s.empty()) return false;
  size_t first = 0;
  while (first < s.size() && std::isspace(static_cast<unsigned char>(s[first]))) first++;
  size_t last = s.size();
  while (last > first && std::isspace(static_cast<unsigned char>(s[last - 1]))) last--;
  return (last > first) && s[first] == '{' && s[last - 1] == '}';
}

std::string buildEventJSON(const std::string& method,
                           const std::string& params,
                           const std::optional<SessionId>& sessionId) {
  std::ostringstream ss;
  ss << "{\"method\":\"" << escapeJSON(method) << "\"";
  // Validate params is a JSON object; fallback to empty object
  ss << ",\"params\":" << (looksLikeJSONObject(params) ? params : std::string("{}"));
  if (sessionId) {
    ss << ",\"sessionId\":\"" << escapeJSON(*sessionId) << "\"";
  }
  ss << "}";
  return ss.str();
}

std::string buildResponseJSON(int id, const std::string& result) {
  std::ostringstream ss;
  ss << "{\"id\":" << id;
  ss << ",\"result\":" << result;
  ss << "}";
  return ss.str();
}

std::string buildErrorJSON(int id, int code, const std::string& message) {
  std::ostringstream ss;
  ss << "{\"id\":" << id;
  ss << ",\"error\":{\"code\":" << code;
  ss << ",\"message\":\"" << escapeJSON(message) << "\"}}";
  return ss.str();
}

std::string escapeJSON(const std::string& str) {
  std::ostringstream ss;
  for (char c : str) {
    switch (c) {
      case '"':  ss << "\\\""; break;
      case '\\': ss << "\\\\"; break;
      case '\b': ss << "\\b"; break;
      case '\f': ss << "\\f"; break;
      case '\n': ss << "\\n"; break;
      case '\r': ss << "\\r"; break;
      case '\t': ss << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          ss << "\\u" << std::hex << std::setfill('0') << std::setw(4) 
             << static_cast<int>(static_cast<unsigned char>(c));
        } else {
          ss << c;
        }
    }
  }
  return ss.str();
}

std::optional<std::string> parseJSONString(const std::string& json, const std::string& key) {
  std::string searchKey = "\"" + key + "\"";
  size_t keyPos = json.find(searchKey);
  if (keyPos == std::string::npos) {
    return std::nullopt;
  }
  
  // Find colon after key
  size_t colonPos = json.find(':', keyPos + searchKey.length());
  if (colonPos == std::string::npos) {
    return std::nullopt;
  }
  
  // Find opening quote
  size_t quoteStart = json.find('"', colonPos + 1);
  if (quoteStart == std::string::npos) {
    return std::nullopt;
  }
  
  // Find closing quote (handle escapes)
  size_t i = quoteStart + 1;
  std::string result;
  while (i < json.size()) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      // Handle escape sequences
      switch (json[i + 1]) {
        case '"':  result += '"'; break;
        case '\\': result += '\\'; break;
        case 'n':  result += '\n'; break;
        case 'r':  result += '\r'; break;
        case 't':  result += '\t'; break;
        default:   result += json[i + 1]; break;
      }
      i += 2;
    } else if (json[i] == '"') {
      return result;
    } else {
      result += json[i];
      i++;
    }
  }
  
  return std::nullopt;
}

std::optional<int> parseJSONInt(const std::string& json, const std::string& key) {
  std::string searchKey = "\"" + key + "\"";
  size_t keyPos = json.find(searchKey);
  if (keyPos == std::string::npos) {
    return std::nullopt;
  }
  
  // Find colon after key
  size_t colonPos = json.find(':', keyPos + searchKey.length());
  if (colonPos == std::string::npos) {
    return std::nullopt;
  }
  
  // Skip whitespace
  size_t numStart = colonPos + 1;
  while (numStart < json.size() && std::isspace(json[numStart])) {
    numStart++;
  }
  
  // Parse number
  if (numStart >= json.size()) {
    return std::nullopt;
  }
  
  bool negative = false;
  if (json[numStart] == '-') {
    negative = true;
    numStart++;
  }
  
  long long result = 0;
  while (numStart < json.size() &&
         std::isdigit(static_cast<unsigned char>(json[numStart]))) {
    result = result * 10 + (json[numStart] - '0');
    if (result > INT32_MAX) {
      return std::nullopt; // Overflow
    }
    numStart++;
  }

  int intResult = static_cast<int>(negative ? -result : result);
  return intResult;
}

} // namespace cdp

} // namespace rill::devtools
