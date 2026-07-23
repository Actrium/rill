// WIP subsystem — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in devtools/CDPServer.h.
#if RILL_WIP_CDP_DEVTOOLS
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
#include "cdp_wire.h"  // cdp:: JSON wire helpers (moved out for the debug wasm)

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
  // Where the WebSocket surface really lives: transports that cannot serve
  // discovery and ws on one listener move ws to a sibling port (Apple). All
  // webSocketDebuggerUrl values are built from this.
  wsPort_ = config_.transport ? config_.transport->webSocketPort(config_.port)
                              : config_.port;
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
          TargetDetachList toDisconnect;
          {
            std::lock_guard<std::mutex> lock(mutex_);
            auto ct = connectionTarget_.find(connId);
            if (ct != connectionTarget_.end()) {
              toDisconnect.emplace_back(connId, ct->second);
              connectionTarget_.erase(ct);
            }
            // Drop EVERY session riding this socket — the path/default-bound one
            // and any Target-attached ones — releasing each attached session's
            // virtual target connection along the way.
            for (auto it = sessions_.begin(); it != sessions_.end();) {
              if (it->second.connectionId == connId) {
                if (it->second.targetConnId != 0 && it->second.target) {
                  toDisconnect.emplace_back(it->second.targetConnId, it->second.target);
                }
                it = sessions_.erase(it);
              } else {
                ++it;
              }
            }
            connectionToSession_.erase(connId);
            connectionTenant_.erase(connId);
            discoveringConnections_.erase(connId);
            connections_.erase(connId);
          }
          // Outside the lock: let the target(s) tear down per-connection state.
          for (auto& [conn, target] : toDisconnect) target->onClientDisconnect(conn);
        });
    // Discovery seam: a path-capable transport serves chrome://inspect's /json
    // probe through this. No-op when the transport never sees a plain GET.
    config_.transport->setOnHttpGet(
        [this](const std::string& method, const std::string& path) {
          return handleDiscoveryRequest(method, path);
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
  TargetDetachList toDisconnect;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    toDisconnect = detachConnectionTargetsLocked(nullptr);
    TargetDetachList sessionDetach = detachSessionTargetsLocked(nullptr);
    toDisconnect.insert(toDisconnect.end(), sessionDetach.begin(), sessionDetach.end());
    sessions_.clear();
    connectionToSession_.clear();
    connectionTenant_.clear();
    discoveringConnections_.clear();
    connections_.clear();
  }
  // Outside the lock: tear down each target's per-connection state.
  for (auto& [connId, target] : toDisconnect) target->onClientDisconnect(connId);

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

  // Tell clients that are discovering targets (Target.setDiscoverTargets) about
  // the new one. Emitting under the lock is safe: sendToConnection does not
  // re-acquire mutex_.
  if (!discoveringConnections_.empty()) {
    std::string params = "{\"targetInfo\":" + buildTargetInfoLocked(id) + "}";
    std::string json = cdp::buildEventJSON("Target.targetCreated", params, std::nullopt);
    for (ConnectionId connId : discoveringConnections_) {
      sendToConnection(connId, json);
    }
  }
}

void CDPServer::registerDebugTarget(TenantId id, std::shared_ptr<IEngineDebugTarget> target) {
  if (!target) {
    unregisterDebugTarget(id);  // erase == unregister (disconnects bound clients)
    return;
  }
  TargetDetachList toDisconnect;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    // Replacing a live target: release every binding to the OLD one first, so
    // no session/connection keeps dispatching into a target the server no
    // longer routes to.
    auto existing = tenantTargets_.find(id);
    if (existing != tenantTargets_.end() && existing->second && existing->second != target) {
      toDisconnect = detachConnectionTargetsLocked(existing->second);
      TargetDetachList sessionDetach = detachSessionTargetsLocked(existing->second);
      toDisconnect.insert(toDisconnect.end(), sessionDetach.begin(), sessionDetach.end());
    }
    tenantTargets_[id] = std::move(target);
  }
  for (auto& [connId, old] : toDisconnect) old->onClientDisconnect(connId);
}

void CDPServer::unregisterDebugTarget(TenantId id) {
  TargetDetachList toDisconnect;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto tt = tenantTargets_.find(id);
    if (tt != tenantTargets_.end()) {
      toDisconnect = detachConnectionTargetsLocked(tt->second);
      TargetDetachList sessionDetach = detachSessionTargetsLocked(tt->second);
      toDisconnect.insert(toDisconnect.end(), sessionDetach.begin(), sessionDetach.end());
      tenantTargets_.erase(tt);
    }
  }
  for (auto& [connId, target] : toDisconnect) target->onClientDisconnect(connId);
}

void CDPServer::unregisterTenant(TenantId id) {
  TargetDetachList toDisconnect;
  {
    std::lock_guard<std::mutex> lock(mutex_);

    // Notify discovering clients before the tenant is gone.
    if (!discoveringConnections_.empty() && tenants_.find(id) != tenants_.end()) {
      std::string params = "{\"targetId\":\"" + std::to_string(id) + "\"}";
      std::string json = cdp::buildEventJSON("Target.targetDestroyed", params, std::nullopt);
      for (ConnectionId connId : discoveringConnections_) {
        sendToConnection(connId, json);
      }
    }

    tenants_.erase(id);
    auto tt = tenantTargets_.find(id);
    if (tt != tenantTargets_.end()) {
      toDisconnect = detachConnectionTargetsLocked(tt->second);
      TargetDetachList sessionDetach = detachSessionTargetsLocked(tt->second);
      toDisconnect.insert(toDisconnect.end(), sessionDetach.begin(), sessionDetach.end());
      tenantTargets_.erase(tt);
    }

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
  for (auto& [connId, target] : toDisconnect) target->onClientDisconnect(connId);
}

CDPServer::TargetDetachList
CDPServer::detachConnectionTargetsLocked(const std::shared_ptr<IEngineDebugTarget>& target) {
  TargetDetachList detached;
  for (auto it = connectionTarget_.begin(); it != connectionTarget_.end();) {
    if (!target || it->second == target) {
      detached.emplace_back(it->first, it->second);
      it = connectionTarget_.erase(it);
    } else {
      ++it;
    }
  }
  return detached;
}

CDPServer::TargetDetachList
CDPServer::detachSessionTargetsLocked(const std::shared_ptr<IEngineDebugTarget>& target) {
  TargetDetachList detached;
  for (auto& [sessionId, session] : sessions_) {
    (void)sessionId;
    if (session.targetConnId == 0 || !session.target) continue;
    if (!target || session.target == target) {
      detached.emplace_back(session.targetConnId, session.target);
      session.targetConnId = 0;
      session.target.reset();
    }
  }
  return detached;
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
  ss << "ws://" << config_.host << ":" << wsPort_ << "/tenant/" << id;
  return ss.str();
}

std::string CDPServer::getDevToolsUrl(TenantId id) const {
  std::string wsUrl = getWebSocketUrl(id);
  // URL encode the WebSocket URL for the DevTools frontend
  std::ostringstream ss;
  ss << "devtools://devtools/bundled/inspector.html?ws=";
  ss << config_.host << ":" << wsPort_ << "/tenant/" << id;
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
  bool needClientConnect = false;
  // When forwarding on behalf of a Target-attached (flatten-mode) session, the
  // target's outbound messages must be tagged with that sessionId so the client
  // can demultiplex them. Empty on the path-bind route (one tenant per socket).
  std::optional<SessionId> sinkSessionId;
  // The connection id the TARGET sees. The raw socket id on the path-bind route;
  // the session's own virtual connection id on the sessionId-attach route, so
  // each of a socket's attached sessions is a separate client to the target
  // (own agent, own sink, own sessionId tag).
  ConnectionId targetConn = connId;
  // Target connections dropped by Target.detachFromTarget while the lock was
  // held; released after it (the target may re-enter the server).
  TargetDetachList deferredTargetDetach;
  bool handledLocally = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);

    // Two routing authorities resolve the tenant this request belongs to:
    //   * an explicit request.sessionId names a session created by
    //     Target.attachToTarget (the sessionId multiplex) — one browser socket
    //     may hold several such sessions, one per attached tenant;
    //   * otherwise the connection's own session (bound to a tenant via the
    //     "/tenant/{id}" path, or the default browser session).
    CDPSession* session = nullptr;
    if (request->sessionId) {
      auto sit = sessions_.find(*request->sessionId);
      if (sit == sessions_.end()) {
        // Unknown sessionId: the session was never attached or has been detached.
        // Do NOT silently reconstruct it — that would keep routing to the tenant
        // after Target.detachFromTarget.
        CDPResponse error = makeError(request->id, CDPErrorCode::SESSION_NOT_FOUND, "Session not found");
        sendResponse(connId, error);
        return;
      }
      session = &sit->second;
      sinkSessionId = *request->sessionId;
    } else {
      session = getOrCreateSessionLocked(connId, *request);
      if (!session) {
        CDPResponse error = makeError(request->id, CDPErrorCode::SESSION_NOT_FOUND, "Session not found");
        sendResponse(connId, error);
        return;
      }
    }
    session->lastActivityAt = currentTimeMs();

    auto it = tenantTargets_.find(session->tenantId);
    if (it != tenantTargets_.end() && it->second && it->second->ownedDomains().owns(domain)) {
      forwardTarget = it->second;  // forward below, outside the lock
      if (sinkSessionId) {
        // sessionId-attach route: bind the SESSION (not the socket) to the
        // target on first owned-domain contact, under a fresh virtual
        // connection id. A second session on the same socket — same tenant or
        // another — gets its own binding instead of silently reusing (and
        // mis-tagging through) the first one's sink.
        if (session->targetConnId != 0 && session->target != forwardTarget) {
          // The tenant's target was replaced since this session last spoke:
          // release the stale binding and connect fresh.
          deferredTargetDetach.emplace_back(session->targetConnId, session->target);
          session->targetConnId = 0;
          session->target.reset();
        }
        if (session->targetConnId == 0) {
          session->targetConnId = generateVirtualConnectionId();
          session->target = forwardTarget;
          needClientConnect = true;
        }
        targetConn = session->targetConnId;
      } else {
        // Path-bind route (one tenant per socket): at most one onClientConnect
        // per raw connection.
        needClientConnect = connectionTarget_.try_emplace(connId, forwardTarget).second;
      }
    } else {
      // Local path: the built-in domain handler synthesizes the response.
      CDPResponse response = routeRequest(*request, *session, deferredTargetDetach);
      sendResponse(connId, response);
      handledLocally = true;
    }
  }  // mutex_ released

  // Outside the lock: release target connections dropped by
  // Target.detachFromTarget (the target tears down that session's agent/sink).
  for (auto& [conn, target] : deferredTargetDetach) target->onClientDisconnect(conn);
  if (handledLocally) return;

  // Owned domain: the target is the sole authority. On first contact install a
  // persistent per-(target)connection sink (the target emits its response AND
  // any async events through it); then forward the raw request verbatim. Both
  // run with mutex_ released so the sink may re-enter the server
  // (sendToConnection) without self-deadlock, and outbound bypasses
  // buildEventJSON (the target already speaks CDP). The sink captures the RAW
  // socket id — that is where bytes go — while the target itself only ever sees
  // targetConn.
  if (needClientConnect) {
    forwardTarget->onClientConnect(targetConn, [this, connId, sinkSessionId](const RawCdpMessage& out) {
      sendToConnection(connId, sinkSessionId ? cdp::injectSessionId(out, *sinkSessionId) : out);
    });
  }
  forwardTarget->dispatch(targetConn, message);
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

CDPResponse CDPServer::routeRequest(const CDPRequest& request, const CDPSession& session,
                                    TargetDetachList& deferredTargetDetach) {
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
    return handleTargetMethod(request, mutableSession, deferredTargetDetach);
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
  // Body-only shim: keep the old "empty string == 404" contract for callers that
  // only want the JSON body. All routing lives in handleDiscoveryRequest.
  HttpResponse resp = handleDiscoveryRequest("GET", path);
  return resp.status == 200 ? resp.body : std::string();
}

HttpResponse CDPServer::handleDiscoveryRequest(const std::string& method,
                                               const std::string& path) const {
  // Loopback-only endpoint: the transport binds 127.0.0.1 and HttpResponse emits
  // no CORS/wildcard headers, so a discovered target list never leaves the box.
  HttpResponse resp;

  if (method != "GET") {
    resp.status = 405;
    resp.statusText = "Method Not Allowed";
    resp.body = R"({"error":"method not allowed"})";
    return resp;
  }

  if (path == "/json" || path == "/json/list") {
    resp.body = buildTargetListJSON();
    return resp;
  }
  if (path == "/json/version") {
    // A single root webSocketDebuggerUrl (no tenant path): stock chrome://inspect
    // opens it and drives tenants through the Target domain (attachToTarget).
    std::ostringstream ss;
    ss << "{\"Browser\":\"Rill/1.0\",\"Protocol-Version\":\"1.3\","
       << "\"webSocketDebuggerUrl\":\"ws://" << config_.host << ":" << wsPort_ << "/\"}";
    resp.body = ss.str();
    return resp;
  }
  if (path == "/json/protocol") {
    resp.body = R"({"domains":[]})";
    return resp;
  }

  resp.status = 404;
  resp.statusText = "Not Found";
  resp.body = R"({"error":"not found"})";
  return resp;
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

SessionId CDPServer::createAttachedSessionLocked(ConnectionId connId, TenantId tenantId) {
  SessionId sessionId = generateSessionId(tenantId);

  CDPSession session;
  session.id = sessionId;
  session.tenantId = tenantId;
  session.connectionId = connId;
  session.createdAt = currentTimeMs();
  session.lastActivityAt = session.createdAt;

  sessions_[sessionId] = std::move(session);
  // NB: intentionally NOT touching connectionToSession_ — an attached session is
  // addressed by its sessionId, and one connection can hold several at once.
  return sessionId;
}

std::string CDPServer::buildTargetInfoLocked(TenantId id) const {
  auto it = tenants_.find(id);
  std::string title = it != tenants_.end() ? it->second.title : std::string();
  std::string url = it != tenants_.end() ? it->second.url : std::string();

  std::ostringstream ss;
  ss << "{\"targetId\":\"" << id << "\",";
  ss << "\"type\":\"node\",";
  ss << "\"title\":\"" << cdp::escapeJSON(title) << "\",";
  ss << "\"url\":\"" << cdp::escapeJSON(url) << "\",";
  ss << "\"attached\":false}";
  return ss.str();
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

CDPResponse CDPServer::handleTargetMethod(const CDPRequest& req, CDPSession& session,
                                          TargetDetachList& deferredTargetDetach) {
  // NB: mutex_ is held by the handleMessage caller for the whole Target flow, so
  // reads of tenants_/sessions_ and emits via sendToConnection are all in-lock
  // and consistent; sendToConnection does not re-acquire the mutex. Target
  // connections to release (detachFromTarget) go into deferredTargetDetach —
  // the caller invokes onClientDisconnect after dropping the lock.
  std::string methodName = req.method.substr(req.method.find('.') + 1);

  if (methodName == "getTargets") {
    std::ostringstream ss;
    ss << "{\"targetInfos\":[";
    bool first = true;
    for (const auto& [id, info] : tenants_) {
      (void)info;
      if (!first) ss << ",";
      first = false;
      ss << buildTargetInfoLocked(id);
    }
    ss << "]}";
    return makeSuccess(req.id, ss.str());
  }

  if (methodName == "setDiscoverTargets") {
    // Chrome enables discovery, then expects a Target.targetCreated burst for the
    // current targets plus create/destroy deltas thereafter (see register/
    // unregisterTenant).
    bool discover = req.params.find("\"discover\":true") != std::string::npos;
    if (discover) {
      discoveringConnections_.insert(session.connectionId);
      for (const auto& [id, info] : tenants_) {
        (void)info;
        std::string params = "{\"targetInfo\":" + buildTargetInfoLocked(id) + "}";
        std::string json = cdp::buildEventJSON("Target.targetCreated", params, std::nullopt);
        sendToConnection(session.connectionId, json);
      }
    } else {
      discoveringConnections_.erase(session.connectionId);
    }
    return makeSuccess(req.id);
  }

  if (methodName == "getTargetInfo") {
    auto targetId = cdp::parseJSONString(req.params, "targetId");
    TenantId id = 0;
    if (targetId) {
      try {
        id = static_cast<TenantId>(std::stoul(*targetId));
      } catch (...) {
        return makeError(req.id, CDPErrorCode::TARGET_NOT_FOUND, "Invalid targetId");
      }
    }
    if (tenants_.find(id) == tenants_.end()) {
      return makeError(req.id, CDPErrorCode::TARGET_NOT_FOUND, "No such target");
    }
    return makeSuccess(req.id, "{\"targetInfo\":" + buildTargetInfoLocked(id) + "}");
  }

  if (methodName == "attachToTarget") {
    auto targetId = cdp::parseJSONString(req.params, "targetId");
    if (!targetId) {
      return makeError(req.id, CDPErrorCode::INVALID_PARAMS, "Missing targetId");
    }
    TenantId id = 0;
    try {
      id = static_cast<TenantId>(std::stoul(*targetId));
    } catch (...) {
      return makeError(req.id, CDPErrorCode::TARGET_NOT_FOUND, "Invalid targetId");
    }
    if (tenants_.find(id) == tenants_.end()) {
      return makeError(req.id, CDPErrorCode::TARGET_NOT_FOUND, "No such target");
    }
    // Create a session bound to the tenant; subsequent requests carry its
    // sessionId and route to this tenant's target (the sessionId multiplex).
    SessionId sid = createAttachedSessionLocked(session.connectionId, id);
    // flatten mode: announce the attach as an event, then reply with the id.
    std::string params = "{\"sessionId\":\"" + cdp::escapeJSON(sid) +
                         "\",\"targetInfo\":" + buildTargetInfoLocked(id) +
                         ",\"waitingForDebugger\":false}";
    std::string evt = cdp::buildEventJSON("Target.attachedToTarget", params, std::nullopt);
    sendToConnection(session.connectionId, evt);
    return makeSuccess(req.id, "{\"sessionId\":\"" + cdp::escapeJSON(sid) + "\"}");
  }

  if (methodName == "detachFromTarget") {
    auto sid = cdp::parseJSONString(req.params, "sessionId");
    if (sid) {
      TenantId tid = 0;
      auto it = sessions_.find(*sid);
      if (it != sessions_.end()) {
        tid = it->second.tenantId;
        // Release the session's virtual target connection too, so the target
        // tears down this session's agent/sink instead of leaking it until the
        // socket closes.
        if (it->second.targetConnId != 0 && it->second.target) {
          deferredTargetDetach.emplace_back(it->second.targetConnId, it->second.target);
        }
        sessions_.erase(it);
      }
      std::string params = "{\"sessionId\":\"" + cdp::escapeJSON(*sid) +
                           "\",\"targetId\":\"" + std::to_string(tid) + "\"}";
      std::string evt = cdp::buildEventJSON("Target.detachedFromTarget", params, std::nullopt);
      sendToConnection(session.connectionId, evt);
    }
    return makeSuccess(req.id);
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

ConnectionId CDPServer::generateVirtualConnectionId() {
  // Own namespace (top bit set): transports hand out their own socket ids, and
  // a target keys per-connection state by whatever id the server presents — a
  // clash would silently merge two clients inside the target.
  constexpr ConnectionId kVirtualBit = ConnectionId(1) << 63;
  return kVirtualBit | nextConnectionId_.fetch_add(1);
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

// buildEventJSON / buildResponseJSON / buildErrorJSON / escapeJSON /
// parseJSONString / parseJSONInt moved to cdp_wire.cpp so the debug wasm can
// link them without CDPServer. The HTTP / discovery helpers below stay here
// because they depend on CDPServer's own types.

std::string buildHttpResponse(const HttpResponse& resp) {
  std::ostringstream ss;
  ss << "HTTP/1.1 " << resp.status << " " << resp.statusText << "\r\n";
  ss << "Content-Type: " << resp.contentType << "\r\n";
  ss << "Content-Length: " << resp.body.size() << "\r\n";
  ss << "\r\n";
  ss << resp.body;
  return ss.str();
}

bool parseRequestLine(const std::string& requestBytes, std::string& method,
                      std::string& path) {
  // Isolate the request line: everything up to the first CRLF. Tolerate a
  // missing CRLF (a bare request line) by falling back to the whole string.
  size_t lineEnd = requestBytes.find("\r\n");
  std::string line = (lineEnd == std::string::npos)
                         ? requestBytes
                         : requestBytes.substr(0, lineEnd);

  // Split the line on runs of spaces into up to three tokens:
  //   [method, target, version]. Only method and target are required.
  std::string tokens[3];
  int count = 0;
  size_t i = 0;
  while (i < line.size() && count < 3) {
    while (i < line.size() && line[i] == ' ') ++i;  // skip leading spaces
    if (i >= line.size()) break;
    size_t start = i;
    while (i < line.size() && line[i] != ' ') ++i;
    tokens[count++] = line.substr(start, i - start);
  }

  if (count < 2 || tokens[0].empty() || tokens[1].empty()) {
    return false;
  }

  method = tokens[0];
  // Path is the target with any query ('?') or fragment ('#') stripped.
  const std::string& target = tokens[1];
  size_t cut = target.find_first_of("?#");
  path = (cut == std::string::npos) ? target : target.substr(0, cut);
  return true;
}

std::string injectSessionId(const std::string& rawCdp, const SessionId& sessionId) {
  // Already tagged, or not a JSON object we can splice into: pass through.
  if (rawCdp.find("\"sessionId\"") != std::string::npos) return rawCdp;
  size_t close = rawCdp.rfind('}');
  size_t open = rawCdp.find('{');
  if (close == std::string::npos || open == std::string::npos || open >= close) {
    return rawCdp;
  }
  // Empty object "{}" needs no leading comma before the new member.
  bool empty = rawCdp.find_first_not_of(" \t\r\n", open + 1) == close;
  std::string member = (empty ? std::string() : std::string(",")) +
                       "\"sessionId\":\"" + escapeJSON(sessionId) + "\"";
  return rawCdp.substr(0, close) + member + rawCdp.substr(close);
}

} // namespace cdp

} // namespace rill::devtools
#endif // RILL_WIP_CDP_DEVTOOLS
