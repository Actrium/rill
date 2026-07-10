// ============================================================================
// WIP — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
//
// WHAT THIS IS
//   A Chrome DevTools Protocol (CDP) server that lets a downstream app developer
//   attach Chrome DevTools / VS Code to a *live guest sandbox* and inspect it.
//   This is developer-facing tooling infrastructure, distinct from:
//     - the internal [DIAG] logging (rill's own diagnostics), and
//     - the TS `rill/devtools` entry (guest-side op-log / profiling / error
//       tracking, which IS wired and shipped).
//
// GOAL
//   Full Chrome DevTools attach to a running guest: Console, DOM tree (from the
//   receiver node tree), Network panel (from host-module traffic), Runtime
//   evaluate, and — the hard part — real breakpoints / stepping.
//
// CURRENT STATUS (why it is gated, not shipped)
//   - Transport (CDPTransportApple): REAL — Network.framework WebSocket server.
//     CDPTransport is an abstract base, so a CDPTransportWeb could be added.
//   - CDPServer + Console/DOM/Network/Runtime adapters: real structure, fed from
//     data rill already owns.
//   - Debugger adapter (breakpoints/stepping): STUB ONLY — IEngineDebugger is a
//     pure interface and NO engine (quickjs/hermes/jsc) implements it; only
//     StubEngineDebugger exists.
//   - It is NEVER constructed in production (test-only), yet was compiled into
//     every native build — hence the gate, to keep it out of release weight
//     while preserving the work as a documented roadmap.
//
// TODO TO COMPLETE (ordered)
//   (see the local architecture deep-review doc, section II.3 addendum, for the
//    full cost analysis behind these estimates)
//   1. Wire the non-breakpoint tiers (days): instantiate CDPServer +
//      CDPTransportApple in RillTenantManager, start(port), registerTenant per
//      tenant, feed Console/DOM/Network/Runtime adapters from existing events.
//   2. Real breakpoints (weeks, per engine):
//      - Hermes: bridge hermes::inspector into IEngineDebugger.
//      - JSC: private inspector API (App Store risk — decide first).
//      - QuickJS: no built-in debugger; requires a forked engine with debug
//        hooks (e.g. koush/quickjs `js_debugger_connect`, which speaks a custom
//        JSON protocol — needs a protocol translator to CDP semantics).
//   3. Web/WASM support: add CDPTransportWeb, compile the C++ stack into the
//      wasm build, and solve single-thread "pause on breakpoint" (Asyncify or
//      multi-worker). Non-breakpoint tiers are cheaper to do in TS instead.
//
// PROCESS / HOW TO BUILD WITH IT
//   Tests always define the flag (native/core/Makefile) so this code keeps
//   compiling and stays honest. For an evaluation native build:
//     RILL_WIP_CDP_DEVTOOLS=1 pod install   (podspec forwards it as a -D define)
// ============================================================================

/**
 * CDPServer.h
 *
 * P3-Y.1: Chrome DevTools Protocol Server
 *
 * Implements a WebSocket server that speaks CDP (Chrome DevTools Protocol),
 * enabling developers to connect Chrome DevTools or VS Code debugger to
 * inspect and debug Guest sandboxes.
 *
 * Features:
 *   - WebSocket server on configurable port (default: 9229)
 *   - /json endpoint for target discovery (chrome://inspect)
 *   - Multi-tenant session management
 *   - CDP message routing to domain adapters
 *
 * Architecture:
 *   Chrome DevTools / VS Code
 *          │
 *          │ WebSocket (ws://localhost:9229)
 *          ▼
 *   ┌─────────────────────────────────────┐
 *   │  CDPServer                          │
 *   │  ├─ WebSocket Transport             │
 *   │  ├─ Protocol Router                 │
 *   │  └─ Session Manager                 │
 *   ├─────────────────────────────────────┤
 *   │  Domain Adapters                    │
 *   │  ├─ ConsoleAdapter                  │
 *   │  ├─ RuntimeAdapter                  │
 *   │  ├─ DOMAdapter                      │
 *   │  ├─ DebuggerAdapter                 │
 *   │  └─ NetworkAdapter                  │
 *   └─────────────────────────────────────┘
 */

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include <atomic>
#include <optional>
#include <unordered_set>

#include "ConnectionId.h"

namespace rill::devtools {

// Forward declarations
class ConsoleAdapter;
class RuntimeAdapter;
class DOMAdapter;
class DebuggerAdapter;
class NetworkAdapter;
class IEngineDebugTarget;

// ============================================
// Type Definitions
// ============================================

/**
 * Tenant identifier type (matches TenantId from TenantContext)
 */
using TenantId = uint32_t;

// ConnectionId lives in ConnectionId.h (shared with the relay seam).

// ============================================
// HTTP Discovery Response
// ============================================

/**
 * A minimal HTTP/1.1 response for the CDP target-discovery endpoint (the
 * `/json*` routes chrome://inspect fetches before it opens a WebSocket).
 *
 * Kept deliberately small and loopback-only: no CORS / wildcard headers are ever
 * emitted, so a discovered target list (tenant titles and URLs) can never leak
 * off-box even if the endpoint is probed cross-origin.
 */
struct HttpResponse {
  int status = 200;
  std::string statusText = "OK";
  std::string contentType = "application/json; charset=UTF-8";
  std::string body;
};

// ============================================
// WebSocket Transport Interface
// ============================================

/**
 * Abstract interface for WebSocket transport layer.
 *
 * Platform-specific implementations (Apple NWListener, Android OkHttp, etc.)
 * should subclass this interface and inject it into CDPServer via
 * CDPServerConfig::transport.
 *
 * The default (nullptr) uses a no-op stub, suitable for unit testing.
 */
class CDPTransport {
public:
  virtual ~CDPTransport() = default;

  /**
   * Message callback: transport calls this when a message arrives.
   */
  using OnMessageCallback = std::function<void(ConnectionId connId, const std::string& message)>;

  /**
   * Connection callback: transport calls this on connect/disconnect.
   * `path` is the WebSocket upgrade request target (e.g. "/tenant/3"); it binds
   * the connection to a tenant. Empty when the transport cannot supply it.
   */
  using OnConnectCallback = std::function<void(ConnectionId connId, const std::string& path)>;
  using OnDisconnectCallback = std::function<void(ConnectionId connId)>;

  /**
   * HTTP GET callback: a path-capable transport calls this for a plain HTTP GET
   * (the chrome://inspect discovery probe) BEFORE any WebSocket upgrade, and
   * writes the returned response straight back to the socket. Transports that
   * cannot surface a plain GET (e.g. an auto-upgrading WebSocket listener) simply
   * never invoke it; CDPServer works either way (unit code calls
   * handleDiscoveryRequest directly).
   */
  using OnHttpGetCallback =
      std::function<HttpResponse(const std::string& method, const std::string& path)>;

  /**
   * Start listening on the given host:port.
   * @return true if started successfully
   */
  virtual bool start(const std::string& host, uint16_t port) = 0;

  /**
   * Stop the transport and close all connections.
   */
  virtual void stop() = 0;

  /**
   * Send a UTF-8 message to a specific connection.
   */
  virtual void send(ConnectionId connId, const std::string& message) = 0;

  /**
   * Close a specific connection.
   */
  virtual void close(ConnectionId connId) = 0;

  /**
   * Register callbacks (called by CDPServer during setup).
   */
  void setOnMessage(OnMessageCallback cb) { onMessage_ = std::move(cb); }
  void setOnConnect(OnConnectCallback cb) { onConnect_ = std::move(cb); }
  void setOnDisconnect(OnDisconnectCallback cb) { onDisconnect_ = std::move(cb); }
  void setOnHttpGet(OnHttpGetCallback cb) { onHttpGet_ = std::move(cb); }

protected:
  OnMessageCallback onMessage_;
  OnConnectCallback onConnect_;
  OnDisconnectCallback onDisconnect_;
  OnHttpGetCallback onHttpGet_;
};

/**
 * CDP session identifier (unique per DevTools connection to a tenant)
 */
using SessionId = std::string;

// ============================================
// CDP Message Types
// ============================================

/**
 * CDP request message (from DevTools to server)
 *
 * JSON-RPC format:
 * {
 *   "id": 1,
 *   "method": "Runtime.evaluate",
 *   "params": { ... },
 *   "sessionId": "tenant-123"  // optional
 * }
 */
struct CDPRequest {
  int id = 0;                    // Request ID for response matching
  std::string method;            // CDP method (e.g., "Runtime.evaluate")
  std::string params;            // JSON params string
  std::optional<SessionId> sessionId;  // Target tenant session (optional for global methods)
};

/**
 * CDP response message (from server to DevTools)
 *
 * JSON-RPC format:
 * {
 *   "id": 1,
 *   "result": { ... }
 * }
 * or error:
 * {
 *   "id": 1,
 *   "error": { "code": -32600, "message": "Invalid Request" }
 * }
 */
struct CDPResponse {
  int id = 0;                    // Matches request ID
  std::string result;            // JSON result (empty if error)
  std::optional<std::string> error;  // JSON error object (if failed)
  
  bool isError() const { return error.has_value(); }
};

/**
 * CDP event message (from server to DevTools, unsolicited)
 *
 * JSON-RPC format:
 * {
 *   "method": "Runtime.consoleAPICalled",
 *   "params": { ... },
 *   "sessionId": "tenant-123"
 * }
 */
struct CDPEvent {
  std::string method;            // Event method (e.g., "Runtime.consoleAPICalled")
  std::string params;            // JSON params
  std::optional<SessionId> sessionId;  // Target session (optional for global events)
};

// ============================================
// CDP Error Codes (JSON-RPC standard + CDP specific)
// ============================================

namespace CDPErrorCode {
  // JSON-RPC standard errors
  constexpr int PARSE_ERROR = -32700;
  constexpr int INVALID_REQUEST = -32600;
  constexpr int METHOD_NOT_FOUND = -32601;
  constexpr int INVALID_PARAMS = -32602;
  constexpr int INTERNAL_ERROR = -32603;
  
  // CDP specific errors
  constexpr int SESSION_NOT_FOUND = -32001;
  constexpr int TARGET_NOT_FOUND = -32002;
  constexpr int TENANT_NOT_AVAILABLE = -32003;
}

// ============================================
// Target Information (for chrome://inspect)
// ============================================

/**
 * CDP target information returned by /json endpoint
 */
struct CDPTarget {
  std::string id;                // Unique target ID (tenant ID as string)
  std::string type = "node";     // Target type (node, page, etc.)
  std::string title;             // Display title (e.g., "Rill Guest: MyApp")
  std::string url;               // Target URL/identifier
  std::string webSocketDebuggerUrl;  // Full WebSocket URL for this target
  std::string devtoolsFrontendUrl;   // DevTools URL (optional)
  std::string faviconUrl;        // Favicon URL (optional)
  
  /**
   * Serialize to JSON string
   */
  std::string toJSON() const;
};

// ============================================
// Session State
// ============================================

/**
 * State for a connected DevTools session
 */
struct CDPSession {
  SessionId id;                  // Session identifier
  TenantId tenantId = 0;         // Associated tenant (0 if not attached)
  ConnectionId connectionId = 0; // WebSocket connection
  
  // Enabled domains
  bool consoleEnabled = false;
  bool runtimeEnabled = false;
  bool debuggerEnabled = false;
  bool domEnabled = false;
  bool networkEnabled = false;
  bool profilerEnabled = false;
  
  // Timestamps
  uint64_t createdAt = 0;
  uint64_t lastActivityAt = 0;
};

// ============================================
// Callbacks & Delegates
// ============================================

/**
 * Callback for evaluating JavaScript in a tenant's context
 */
using EvaluateCallback = std::function<std::string(
  TenantId tenantId,
  const std::string& expression,
  bool returnByValue
)>;

/**
 * Callback for getting component tree from Receiver
 */
using GetComponentTreeCallback = std::function<std::string(TenantId tenantId)>;

/**
 * Server configuration
 */
struct CDPServerConfig {
  uint16_t port = 9229;          // WebSocket port
  std::string host = "127.0.0.1"; // Bind address (localhost only for security)
  bool enabled = true;           // Enable/disable server
  size_t maxConnections = 10;    // Max concurrent connections
  uint32_t pingIntervalMs = 30000; // WebSocket ping interval
  
  // Callbacks (must be set before start)
  EvaluateCallback onEvaluate;
  GetComponentTreeCallback onGetComponentTree;

  // WebSocket transport (nullptr = no-op stub for testing)
  std::shared_ptr<CDPTransport> transport;
};

// ============================================
// CDPServer Class
// ============================================

/**
 * Chrome DevTools Protocol Server
 *
 * Thread-safety:
 *   - All public methods are thread-safe
 *   - Internal state protected by mutex
 *   - WebSocket I/O runs on dedicated thread
 */
class CDPServer {
public:
  /**
   * Create CDP server with configuration
   */
  explicit CDPServer(CDPServerConfig config = {});
  
  /**
   * Destructor - stops server if running
   */
  ~CDPServer();
  
  // Non-copyable, non-movable
  CDPServer(const CDPServer&) = delete;
  CDPServer& operator=(const CDPServer&) = delete;
  CDPServer(CDPServer&&) = delete;
  CDPServer& operator=(CDPServer&&) = delete;
  
  // ============================================
  // Lifecycle
  // ============================================
  
  /**
   * Start the WebSocket server
   * @return true if started successfully
   */
  bool start();
  
  /**
   * Stop the WebSocket server
   * Closes all connections gracefully
   */
  void stop();
  
  /**
   * Check if server is running
   */
  bool isRunning() const;
  
  /**
   * Get server port
   */
  uint16_t getPort() const { return config_.port; }
  
  // ============================================
  // Tenant Management
  // ============================================
  
  /**
   * Register a tenant as a debuggable target
   * @param id Tenant ID
   * @param title Display title for DevTools
   * @param url Optional URL/identifier
   */
  void registerTenant(TenantId id, const std::string& title, const std::string& url = "");
  
  /**
   * Unregister a tenant
   * Closes any sessions connected to this tenant
   */
  void unregisterTenant(TenantId id);
  
  /**
   * Check if tenant is registered
   */
  bool hasTenant(TenantId id) const;
  
  /**
   * Get all registered tenant IDs
   */
  std::vector<TenantId> getTenantIds() const;

  // ============================================
  // Debug Targets (relay seam)
  // ============================================

  /**
   * Register a per-tenant debug target. A request whose CDP domain the target
   * owns (see IEngineDebugTarget::ownedDomains) is forwarded to it verbatim,
   * OUTSIDE the server lock, and the target alone emits the response and any
   * events — the built-in domain handlers are bypassed for that domain. Domains
   * the target does not own keep going through the local handlers.
   */
  void registerDebugTarget(TenantId id, std::shared_ptr<IEngineDebugTarget> target);

  /**
   * Remove a tenant's debug target (its owned domains fall back to local handlers).
   */
  void unregisterDebugTarget(TenantId id);

  /**
   * Parse a tenant id from a WebSocket upgrade path of the form
   * ".../tenant/{id}". Returns nullopt when the path carries no tenant segment.
   */
  static std::optional<TenantId> parseTenantFromPath(const std::string& path);

  // ============================================
  // Event Emission
  // ============================================
  
  /**
   * Send CDP event to all sessions connected to a tenant
   * @param tenantId Target tenant
   * @param event CDP event to send
   */
  void sendEvent(TenantId tenantId, const CDPEvent& event);
  
  /**
   * Send CDP event to a specific session
   */
  void sendEventToSession(const SessionId& sessionId, const CDPEvent& event);
  
  /**
   * Broadcast event to all connected sessions
   */
  void broadcastEvent(const CDPEvent& event);
  
  // ============================================
  // URL Helpers
  // ============================================
  
  /**
   * Get WebSocket URL for a tenant
   * @return URL like "ws://127.0.0.1:9229/tenant/123"
   */
  std::string getWebSocketUrl(TenantId id) const;
  
  /**
   * Get DevTools URL for a tenant
   * @return URL like "devtools://devtools/bundled/inspector.html?ws=..."
   */
  std::string getDevToolsUrl(TenantId id) const;
  
  /**
   * Get /json endpoint URL
   */
  std::string getTargetListUrl() const;
  
  // ============================================
  // Statistics
  // ============================================
  
  /**
   * Get number of active connections
   */
  size_t getConnectionCount() const;
  
  /**
   * Get number of active sessions
   */
  size_t getSessionCount() const;
  
  /**
   * Get total messages received
   */
  uint64_t getMessagesReceived() const { return messagesReceived_.load(); }
  
  /**
   * Get total messages sent
   */
  uint64_t getMessagesSent() const { return messagesSent_.load(); }

  // ============================================
  // HTTP Handling (for /json endpoint)
  // ============================================

  /**
   * Handle HTTP request (for /json target discovery)
   * @return JSON response body, empty string for 404
   *
   * Body-only shim over handleDiscoveryRequest, kept for callers/tests that only
   * want the JSON body and treat 404 as empty.
   */
  std::string handleHttpRequest(const std::string& path);

  /**
   * Handle a CDP discovery HTTP request (what chrome://inspect fetches to
   * enumerate targets). GET-only; anything else is 405. Routes:
   *   /json, /json/list  -> 200 target list (buildTargetListJSON)
   *   /json/version      -> 200 Browser + Protocol-Version + a single root
   *                         webSocketDebuggerUrl (no tenant path)
   *   /json/protocol     -> 200 {"domains":[]}
   *   anything else      -> 404
   * Loopback-only by construction: no CORS/wildcard headers are emitted (see
   * HttpResponse). Safe to call with mutex_ released — it locks internally only
   * where it needs the tenant list.
   */
  HttpResponse handleDiscoveryRequest(const std::string& method, const std::string& path) const;

private:
  // ============================================
  // Internal Types
  // ============================================
  
  struct Connection {
    ConnectionId id = 0;
    std::string remoteAddress;
    uint64_t connectedAt = 0;
    // Platform-specific socket handle stored separately
  };
  
  struct TenantInfo {
    TenantId id = 0;
    std::string title;
    std::string url;
    uint64_t registeredAt = 0;
  };
  
  // ============================================
  // Message Handling
  // ============================================
  
  /**
   * Handle incoming WebSocket message
   */
  void handleMessage(ConnectionId connId, const std::string& message);
  
  /**
   * Parse CDP request from JSON
   */
  std::optional<CDPRequest> parseRequest(const std::string& json);
  
  /**
   * Route request to appropriate domain adapter
   */
  CDPResponse routeRequest(const CDPRequest& request, const CDPSession& session);
  
  /**
   * Send response to connection
   */
  void sendResponse(ConnectionId connId, const CDPResponse& response);
  
  /**
   * Send event to connection
   */
  void sendToConnection(ConnectionId connId, const std::string& json);
  
  /**
   * Build target list JSON for /json endpoint
   */
  std::string buildTargetListJSON() const;
  
  // ============================================
  // Session Management
  // ============================================
  
  /**
   * Create new session for connection
   */
  SessionId createSession(ConnectionId connId, TenantId tenantId);
  
  /**
   * Get session by ID
   */
  CDPSession* getSession(const SessionId& id);
  
  /**
   * Remove session
   */
  void removeSession(const SessionId& id);
  
  /**
   * Get or create session from request (caller must hold mutex_)
   */
  CDPSession* getOrCreateSessionLocked(ConnectionId connId, const CDPRequest& request);

  /**
   * Create a session bound to `tenantId` for a Target.attachToTarget request and
   * return its id. Unlike createSession this does NOT claim connectionToSession_,
   * so one connection may hold several attached sessions at once — the sessionId
   * multiplex, where each subsequent request names its session explicitly.
   * Caller must hold mutex_.
   */
  SessionId createAttachedSessionLocked(ConnectionId connId, TenantId tenantId);

  /**
   * Build a CDP Target.TargetInfo object ("{...}") for tenant `id`.
   * Caller must hold mutex_.
   */
  std::string buildTargetInfoLocked(TenantId id) const;

  /**
   * Remove and return the (connection, target) bindings matching `target`
   * (nullptr = all), so the caller can invoke onClientDisconnect OUTSIDE the
   * lock. Caller must hold mutex_.
   */
  std::vector<std::pair<ConnectionId, std::shared_ptr<IEngineDebugTarget>>>
  detachConnectionTargetsLocked(const std::shared_ptr<IEngineDebugTarget>& target);
  
  // ============================================
  // Domain Handlers
  // ============================================
  
  CDPResponse handleRuntimeMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleConsoleMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleDebuggerMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleDOMMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleNetworkMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleProfilerMethod(const CDPRequest& req, CDPSession& session);
  CDPResponse handleTargetMethod(const CDPRequest& req, CDPSession& session);
  
  // ============================================
  // Utility
  // ============================================
  
  /**
   * Generate unique connection ID
   */
  ConnectionId generateConnectionId();
  
  /**
   * Generate unique session ID
   */
  SessionId generateSessionId(TenantId tenantId);
  
  /**
   * Get current timestamp in milliseconds
   */
  static uint64_t currentTimeMs();
  
  /**
   * Build error response
   */
  static CDPResponse makeError(int requestId, int code, const std::string& message);
  
  /**
   * Build success response
   */
  static CDPResponse makeSuccess(int requestId, const std::string& resultJson = "{}");
  
  // ============================================
  // State
  // ============================================
  
  CDPServerConfig config_;
  
  mutable std::mutex mutex_;
  
  // Server state
  std::atomic<bool> running_{false};
  std::unique_ptr<std::thread> serverThread_;
  
  // Connections
  std::unordered_map<ConnectionId, Connection> connections_;
  std::atomic<ConnectionId> nextConnectionId_{1};
  
  // Sessions
  std::unordered_map<SessionId, CDPSession> sessions_;
  std::unordered_map<ConnectionId, SessionId> connectionToSession_;
  // Tenant bound at connect time from the "/tenant/{id}" upgrade path. Takes
  // precedence over the per-request sessionId when creating a session.
  std::unordered_map<ConnectionId, TenantId> connectionTenant_;
  // Connections that have been handed to a debug target (first owned-domain
  // request installs the target's persistent sink). Drives onClientDisconnect on
  // teardown so the target can drop per-connection state.
  std::unordered_map<ConnectionId, std::shared_ptr<IEngineDebugTarget>> connectionTarget_;
  // Connections that issued Target.setDiscoverTargets{discover:true}; they receive
  // Target.targetCreated / Target.targetDestroyed as tenants come and go.
  std::unordered_set<ConnectionId> discoveringConnections_;

  // Registered tenants
  std::unordered_map<TenantId, TenantInfo> tenants_;

  // Per-tenant debug targets (relay seam). A request for a domain the target
  // owns is forwarded verbatim outside the lock; see handleMessage.
  std::unordered_map<TenantId, std::shared_ptr<IEngineDebugTarget>> tenantTargets_;
  
  // Statistics
  std::atomic<uint64_t> messagesReceived_{0};
  std::atomic<uint64_t> messagesSent_{0};
};

// ============================================
// Helper: Build CDP JSON messages
// ============================================

namespace cdp {

/**
 * Build CDP event JSON
 */
std::string buildEventJSON(const std::string& method, 
                           const std::string& params,
                           const std::optional<SessionId>& sessionId = std::nullopt);

/**
 * Build CDP response JSON
 */
std::string buildResponseJSON(int id, const std::string& result);

/**
 * Build CDP error response JSON
 */
std::string buildErrorJSON(int id, int code, const std::string& message);

/**
 * Frame an HttpResponse into an HTTP/1.1 wire string: status line, Content-Type,
 * Content-Length, blank line, then body. No CORS headers by design (loopback
 * only).
 */
std::string buildHttpResponse(const HttpResponse& resp);

/**
 * Insert a top-level "sessionId" member into a raw CDP message object if it does
 * not already carry one. Used to tag a Target-attached (flatten-mode) session's
 * outbound messages so the client can demultiplex them.
 */
std::string injectSessionId(const std::string& rawCdp, const SessionId& sessionId);

/**
 * Escape string for JSON
 */
std::string escapeJSON(const std::string& str);

/**
 * Parse JSON string value
 */
std::optional<std::string> parseJSONString(const std::string& json, const std::string& key);

/**
 * Parse JSON int value
 */
std::optional<int> parseJSONInt(const std::string& json, const std::string& key);

} // namespace cdp

} // namespace rill::devtools
