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

  (void)host; // Currently ignored; listener binds to the given port.

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

  // Create listener on the requested port.
  std::string portStr = std::to_string(port);
  nw_listener_t listener = nw_listener_create_with_port(portStr.c_str(), params);
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

} // namespace rill::devtools

#endif // __APPLE__
#endif // RILL_WIP_CDP_DEVTOOLS
