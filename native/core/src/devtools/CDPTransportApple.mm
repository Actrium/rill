// WIP subsystem — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in devtools/CDPServer.h.
#if RILL_WIP_CDP_DEVTOOLS
/**
 * CDPTransportApple.mm
 *
 * M5-B: Apple Platform WebSocket Transport Implementation
 *
 * Uses Network.framework C API (nw_listener_t / nw_connection_t / ws_options.h)
 * to implement a WebSocket server for Chrome DevTools Protocol.
 *
 * FOLLOW-UP (portable half already landed in CDPServer): the /json discovery
 * endpoint (CDPServer::handleDiscoveryRequest + CDPTransport::setOnHttpGet) is
 * now served by this transport. Network.framework's nw_ws listener performs the
 * WebSocket upgrade for us and only ever yields WebSocket frames — a client that
 * speaks plain HTTP GET / on the same port never surfaces its request line or
 * path here, so there is nothing to hand to onHttpGet_ from the ws listener.
 * Two ways to wire the discovery probe were considered:
 *   (a) CHOSEN — a second plain-TCP nw_listener (no ws options) on a sibling
 *       port (ws port + 1) that reads the request line, calls
 *       onHttpGet_(method, path), and writes back cdp::buildHttpResponse(...).
 *       Kept 127.0.0.1-only, same as the ws port (see startHttpListener).
 *   (b) REJECTED — a single port that sniffs the first bytes of each accepted
 *       TCP connection. Infeasible with nw_ws: once bytes are peeked off a raw
 *       nw_connection they cannot be re-injected into the ws protocol stack, so
 *       a sniffed connection can no longer be handed to the WebSocket upgrade.
 * Neither is required for stock chrome://inspect: it opens the root
 * webSocketDebuggerUrl and enumerates/attaches guests entirely over the Target
 * domain (setDiscoverTargets / attachToTarget) that CDPServer now implements, so
 * the sessionId multiplex is the working tenant-routing path on this transport.
 * The sibling listener additionally lets chrome://inspect's /json probe (and
 * curl) enumerate tenants directly. webSocketDebuggerUrl is unchanged: the ws
 * surface stays on the config port; discovery answers on port + 1.
 */

#import "CDPTransportApple.h"

#ifdef __APPLE__

#import <Network/Network.h>
#import <Foundation/Foundation.h>

#include <cstdlib>
#include <cstring>

namespace rill::devtools {

namespace {

// Keep a shared ws protocol definition to avoid repeated create/release in hot paths.
static nw_protocol_definition_t wsDefinition() {
  static nw_protocol_definition_t def = nullptr;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    def = nw_protocol_copy_ws_definition();
  });
  return def;
}

static bool isCloseFrame(nw_content_context_t context) {
  if (context == nullptr) return false;

  nw_protocol_metadata_t meta = nw_content_context_copy_protocol_metadata(context, wsDefinition());
  if (meta == nullptr) return false;

  bool isClose = false;
  if (nw_protocol_metadata_is_ws(meta)) {
    isClose = (nw_ws_metadata_get_opcode(meta) == nw_ws_opcode_close);
  }
  return isClose;
}

static std::string dispatchDataToString(dispatch_data_t data) {
  if (data == nullptr) return {};

  const void *buffer = nullptr;
  size_t size = 0;
  dispatch_data_t mapped = dispatch_data_create_map(data, &buffer, &size);
  (void)mapped; // mapped keeps the buffer alive
  if (buffer == nullptr || size == 0) return {};
  return std::string(static_cast<const char *>(buffer), size);
}

static dispatch_data_t copyStringToDispatchData(dispatch_queue_t queue, const std::string &message) {
  if (message.empty()) {
    return dispatch_data_empty;
  }

  void *buf = malloc(message.size());
  if (!buf) return dispatch_data_empty;
  memcpy(buf, message.data(), message.size());

  return dispatch_data_create(
      buf,
      message.size(),
      queue,
      ^{
        free(buf);
      });
}

static nw_content_context_t createWSTextContext() {
  nw_content_context_t ctx = nw_content_context_create("cdp");
  nw_protocol_metadata_t meta = nw_ws_create_metadata(nw_ws_opcode_text);
  nw_content_context_set_metadata_for_protocol(ctx, meta);
  return ctx;
}

// Create a listener from already-configured parameters, pinned to a loopback
// local endpoint. nw_listener_create_with_port binds every interface; requiring
// a 127.0.0.1 local endpoint keeps both the ws surface and the /json discovery
// list (which carries tenant titles and URLs) off the LAN.
static nw_listener_t createLoopbackListener(nw_parameters_t params,
                                            const std::string& host,
                                            uint16_t port) {
  const char* hostStr = host.empty() ? "127.0.0.1" : host.c_str();
  std::string portStr = std::to_string(port);
  nw_endpoint_t endpoint = nw_endpoint_create_host(hostStr, portStr.c_str());
  nw_parameters_set_local_endpoint(params, endpoint);
  return nw_listener_create(params);
}

} // namespace

CDPTransportApple::CDPTransportApple() {
  queue_ = dispatch_queue_create("rill.cdp.transport", DISPATCH_QUEUE_SERIAL);
}

CDPTransportApple::~CDPTransportApple() {
  stop();
  // queue_ is ARC-managed in ObjC++ mode
}

bool CDPTransportApple::start(const std::string& host, uint16_t port) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (running_.load()) {
    return false; // Already running
  }

  nw_parameters_t params = nw_parameters_create_secure_tcp(
      NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  if (params == nullptr) {
    return false;
  }

  // Configure WebSocket options and push into protocol stack.
  nw_protocol_stack_t stack = nw_parameters_copy_default_protocol_stack(params);
  nw_protocol_options_t wsOptions = nw_ws_create_options(nw_ws_version_13);
  nw_ws_options_set_maximum_message_size(wsOptions, 16 * 1024 * 1024);
  nw_protocol_stack_prepend_application_protocol(stack, wsOptions);

  // Create the ws listener bound to loopback only (see createLoopbackListener).
  nw_listener_t listener = createLoopbackListener(params, host, port);
  // ARC owns params; let it release automatically.

  if (listener == nullptr) {
    return false;
  }

  nw_listener_set_queue(listener, queue_);

  nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
    // Keep the connection alive beyond this block; released when removed from the map.
    void *connPtr = (__bridge_retained void *)connection;
    this->handleNewConnection(connPtr);
  });

  nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
    switch (state) {
      case nw_listener_state_ready:
        NSLog(@"[CDPTransport] Listening on port %u", port);
        break;
      case nw_listener_state_failed:
        NSLog(@"[CDPTransport] Listener failed: %@", error ? (id)error : @"(unknown)");
        this->stop();
        break;
      case nw_listener_state_cancelled:
        NSLog(@"[CDPTransport] Listener cancelled");
        break;
      default:
        break;
    }
  });

  nw_listener_start(listener);

  // Store for later stop().
  listener_ = (__bridge_retained void *)listener;

  running_.store(true);

  // Bring up the sibling plain-TCP discovery listener on port + 1. Its failure
  // is non-fatal: the ws/Target-domain path still routes tenants, so we log and
  // carry on rather than tearing down a working ws surface.
  if (!startHttpListener(host, static_cast<uint16_t>(port + 1))) {
    NSLog(@"[CDPTransport] HTTP discovery listener did not start on port %u (non-fatal)",
          static_cast<unsigned>(port + 1));
  }

  return true;
}

void CDPTransportApple::stop() {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!running_.load()) return;

  running_.store(false);

  // Cancel all connections
  for (auto& [id, connPtr] : connections_) {
    nw_connection_t conn = (__bridge_transfer nw_connection_t)connPtr;
    nw_connection_cancel(conn);
  }
  connections_.clear();

  // Cancel listener
  if (listener_) {
    nw_listener_t listener = (__bridge_transfer nw_listener_t)listener_;
    nw_listener_cancel(listener);
    listener_ = nullptr;
  }

  // Tear down the HTTP discovery sibling listener and drop any in-flight request
  // buffers. Discovery connections are ephemeral (one request, one response),
  // so cancelling the listener stops new ones and outstanding receive callbacks
  // unwind against the now-empty buffer map.
  if (httpListener_) {
    nw_listener_t httpListener = (__bridge_transfer nw_listener_t)httpListener_;
    nw_listener_cancel(httpListener);
    httpListener_ = nullptr;
  }
  httpBuffers_.clear();
  httpPort_ = 0;
}

void CDPTransportApple::send(ConnectionId connId, const std::string& message) {
  std::lock_guard<std::mutex> lock(mutex_);

  auto it = connections_.find(connId);
  if (it == connections_.end()) return;

  nw_connection_t conn = (__bridge nw_connection_t)it->second;

  dispatch_data_t content = copyStringToDispatchData(queue_, message);
  nw_content_context_t ctx = createWSTextContext();

  nw_connection_send(
      conn,
      content,
      ctx,
      true,
      ^(nw_error_t error) {
        if (error) {
          NSLog(@"[CDPTransport] Send error for connection %llu: %@", connId, (id)error);
        }
      });
}

void CDPTransportApple::close(ConnectionId connId) {
  std::lock_guard<std::mutex> lock(mutex_);

  auto it = connections_.find(connId);
  if (it == connections_.end()) return;

  void *connPtr = it->second;
  connections_.erase(it);

  nw_connection_t conn = (__bridge_transfer nw_connection_t)connPtr;
  nw_connection_cancel(conn);

  // Notify disconnect
  if (onDisconnect_) {
    onDisconnect_(connId);
  }
}

size_t CDPTransportApple::getConnectionCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return connections_.size();
}

// ============================================
// Private Methods
// ============================================

void CDPTransportApple::handleNewConnection(void* nwConnection) {
  nw_connection_t conn = (__bridge nw_connection_t)nwConnection;

  ConnectionId connId = nextId_.fetch_add(1);

  // Store connection
  {
    std::lock_guard<std::mutex> lock(mutex_);
    connections_[connId] = nwConnection; // Already retained in listener callback
  }

  nw_connection_set_queue(conn, queue_);

  // Start the connection
  nw_connection_set_state_changed_handler(conn, ^(nw_connection_state_t state, nw_error_t error) {
    switch (state) {
      case nw_connection_state_ready:
        NSLog(@"[CDPTransport] Connection %llu ready", connId);
        if (this->onConnect_) {
          // Network.framework's server-side WebSocket (nw_ws_request) exposes
          // subprotocols and additional headers but not the HTTP request-line
          // target, so the "/tenant/{id}" path shortcut is unavailable here.
          // Tenant routing on this transport therefore relies on the CDP-standard
          // sessionId (target-attach) flow handled by CDPServer. The path arg is
          // wired for transports/clients that can supply it (discovery endpoint).
          this->onConnect_(connId, std::string());
        }
        this->receiveLoop(connId);
        break;
      case nw_connection_state_failed:
        NSLog(@"[CDPTransport] Connection %llu failed: %@", connId, error ? (id)error : @"(unknown)");
        this->removeConnection(connId);
        break;
      case nw_connection_state_cancelled:
        NSLog(@"[CDPTransport] Connection %llu cancelled", connId);
        this->removeConnection(connId);
        break;
      default:
        break;
    }
  });

  nw_connection_start(conn);
}

void CDPTransportApple::receiveLoop(ConnectionId connId) {
  void* connPtr = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = connections_.find(connId);
    if (it == connections_.end()) return;
    connPtr = it->second;
  }

  nw_connection_t conn = (__bridge nw_connection_t)connPtr;

  nw_connection_receive_message(conn, ^(dispatch_data_t content,
                                        nw_content_context_t context,
                                        bool is_complete,
                                        nw_error_t error) {
    (void)is_complete;

    if (error || content == nullptr) {
      if (error) {
        NSLog(@"[CDPTransport] Receive error on connection %llu: %@", connId, (id)error);
      }
      this->removeConnection(connId);
      return;
    }

    if (isCloseFrame(context)) {
      this->removeConnection(connId);
      return;
    }

    std::string message = dispatchDataToString(content);
    if (!message.empty() && this->onMessage_) {
      this->onMessage_(connId, message);
    }

    if (this->running_.load()) {
      this->receiveLoop(connId);
    }
  });
}

void CDPTransportApple::removeConnection(ConnectionId connId) {
  void* connPtr = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = connections_.find(connId);
    if (it == connections_.end()) return;
    connPtr = it->second;
    connections_.erase(it);
  }

  nw_connection_t conn = (__bridge_transfer nw_connection_t)connPtr;
  nw_connection_cancel(conn);

  if (onDisconnect_) {
    onDisconnect_(connId);
  }
}

// ============================================
// HTTP discovery sibling listener
// ============================================

bool CDPTransportApple::startHttpListener(const std::string& host, uint16_t port) {
  // Plain TCP: no WebSocket options in the protocol stack. The discovery client
  // speaks raw HTTP/1.1 GET and we answer with a single framed HttpResponse.
  nw_parameters_t params = nw_parameters_create_secure_tcp(
      NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  if (params == nullptr) {
    return false;
  }

  nw_listener_t listener = createLoopbackListener(params, host, port);
  if (listener == nullptr) {
    return false;
  }

  nw_listener_set_queue(listener, queue_);

  nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
    // Retain the connection past this block; released in closeHttpConnection.
    void *connPtr = (__bridge_retained void *)connection;
    this->handleNewHttpConnection(connPtr);
  });

  nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
    switch (state) {
      case nw_listener_state_ready:
        NSLog(@"[CDPTransport] HTTP discovery listening on port %u", port);
        break;
      case nw_listener_state_failed:
        // Non-fatal: the ws surface keeps working without discovery.
        NSLog(@"[CDPTransport] HTTP discovery listener failed: %@",
              error ? (id)error : @"(unknown)");
        break;
      case nw_listener_state_cancelled:
        NSLog(@"[CDPTransport] HTTP discovery listener cancelled");
        break;
      default:
        break;
    }
  });

  nw_listener_start(listener);

  httpListener_ = (__bridge_retained void *)listener;
  httpPort_ = port;
  return true;
}

void CDPTransportApple::handleNewHttpConnection(void* nwConnection) {
  nw_connection_t conn = (__bridge nw_connection_t)nwConnection;

  ConnectionId connId = nextId_.fetch_add(1);

  // Allocate the per-connection read buffer.
  {
    std::lock_guard<std::mutex> lock(mutex_);
    httpBuffers_[connId] = std::make_shared<std::string>();
  }

  nw_connection_set_queue(conn, queue_);

  nw_connection_set_state_changed_handler(conn, ^(nw_connection_state_t state, nw_error_t error) {
    switch (state) {
      case nw_connection_state_ready:
        this->httpReceiveLoop(connId, nwConnection);
        break;
      case nw_connection_state_failed:
        NSLog(@"[CDPTransport] HTTP connection %llu failed: %@", connId,
              error ? (id)error : @"(unknown)");
        this->closeHttpConnection(connId, nwConnection);
        break;
      case nw_connection_state_cancelled:
        this->closeHttpConnection(connId, nwConnection);
        break;
      default:
        break;
    }
  });

  nw_connection_start(conn);
}

void CDPTransportApple::httpReceiveLoop(ConnectionId connId, void* nwConnection) {
  std::shared_ptr<std::string> buffer;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = httpBuffers_.find(connId);
    if (it == httpBuffers_.end()) return;  // already closed
    buffer = it->second;
  }

  nw_connection_t conn = (__bridge nw_connection_t)nwConnection;

  nw_connection_receive(conn, 1, 8192, ^(dispatch_data_t content,
                                         nw_content_context_t context,
                                         bool is_complete,
                                         nw_error_t error) {
    (void)context;

    if (content != nullptr) {
      buffer->append(dispatchDataToString(content));

      // Header terminator seen: the request line + headers are complete.
      if (buffer->find("\r\n\r\n") != std::string::npos) {
        this->finishHttpRequest(connId, nwConnection, *buffer);
        return;
      }

      // Header flood guard: refuse an oversized request and close.
      if (buffer->size() > 8192) {
        HttpResponse tooLarge;
        tooLarge.status = 431;
        tooLarge.statusText = "Request Header Fields Too Large";
        tooLarge.body = R"({"error":"request header fields too large"})";
        std::string wire = cdp::buildHttpResponse(tooLarge);
        dispatch_data_t out = copyStringToDispatchData(this->queue_, wire);
        nw_connection_send(conn, out, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true,
                           ^(nw_error_t) {
                             this->closeHttpConnection(connId, nwConnection);
                           });
        return;
      }
    }

    if (error || is_complete) {
      // EOF or error before a full request: nothing to answer.
      this->closeHttpConnection(connId, nwConnection);
      return;
    }

    if (this->running_.load()) {
      this->httpReceiveLoop(connId, nwConnection);
    } else {
      this->closeHttpConnection(connId, nwConnection);
    }
  });
}

void CDPTransportApple::finishHttpRequest(ConnectionId connId, void* nwConnection,
                                          const std::string& request) {
  nw_connection_t conn = (__bridge nw_connection_t)nwConnection;

  std::string method, path;
  HttpResponse resp;
  if (cdp::parseRequestLine(request, method, path)) {
    resp = onHttpGet_ ? onHttpGet_(method, path)
                      : HttpResponse{404, "Not Found",
                                     "application/json; charset=UTF-8",
                                     R"({"error":"not found"})"};
  } else {
    resp.status = 400;
    resp.statusText = "Bad Request";
    resp.body = R"({"error":"bad request"})";
  }

  std::string wire = cdp::buildHttpResponse(resp);
  dispatch_data_t out = copyStringToDispatchData(queue_, wire);

  // Cancel ONLY inside the send completion: cancelling before the write drains
  // would drop the response on the floor.
  nw_connection_send(conn, out, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true,
                     ^(nw_error_t error) {
                       if (error) {
                         NSLog(@"[CDPTransport] HTTP send error on %llu: %@", connId,
                               (id)error);
                       }
                       this->closeHttpConnection(connId, nwConnection);
                     });
}

void CDPTransportApple::closeHttpConnection(ConnectionId connId, void* nwConnection) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = httpBuffers_.find(connId);
    if (it == httpBuffers_.end()) {
      return;  // already closed: do not transfer/cancel the connection twice
    }
    httpBuffers_.erase(it);
  }

  nw_connection_t conn = (__bridge_transfer nw_connection_t)nwConnection;
  nw_connection_cancel(conn);
}

} // namespace rill::devtools

#endif // __APPLE__
#endif // RILL_WIP_CDP_DEVTOOLS
