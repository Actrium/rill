/**
 * CDPTransportApple.h
 *
 * M5-B: Apple Platform WebSocket Transport for CDP Server
 *
 * Implements CDPTransport using Apple's Network.framework:
 *   - NWListener for WebSocket server
 *   - NWConnection for individual client connections
 *   - NWProtocolWebSocket for WebSocket frame handling
 *
 * Requires: Network.framework (iOS 13+, macOS 10.15+)
 */

#pragma once

#include "CDPServer.h"

#ifdef __APPLE__

#include <dispatch/dispatch.h>
#include <unordered_map>
#include <mutex>
#include <atomic>
#include <memory>
#include <string>

namespace rill::devtools {

/**
 * Apple Network.framework WebSocket transport
 *
 * Thread-safety:
 *   - All public methods are thread-safe
 *   - Internal state protected by mutex
 *   - Network I/O runs on a dedicated dispatch queue
 */
class CDPTransportApple : public CDPTransport {
public:
  CDPTransportApple();
  ~CDPTransportApple() override;

  // CDPTransport interface
  bool start(const std::string& host, uint16_t port) override;
  void stop() override;
  void send(ConnectionId connId, const std::string& message) override;
  void close(ConnectionId connId) override;

  /**
   * The ws surface lives on the sibling port: the configured port itself serves
   * the /json discovery routes (what chrome://inspect probes), and the
   * auto-upgrading nw_ws listener — which cannot answer a plain HTTP GET —
   * moves one up. start() rejects port 65535, so this never wraps.
   */
  uint16_t webSocketPort(uint16_t configuredPort) const override {
    return static_cast<uint16_t>(configuredPort + 1);
  }

  /**
   * Get number of active connections
   */
  size_t getConnectionCount() const;

private:
  /**
   * Set up a new incoming connection
   */
  void handleNewConnection(void* nwConnection);

  /**
   * Start receiving messages on a connection
   */
  void receiveLoop(ConnectionId connId);

  /**
   * Clean up a closed connection
   */
  void removeConnection(ConnectionId connId);

  // ============================================
  // HTTP discovery sibling listener (chrome://inspect /json* probe)
  // ============================================

  /**
   * Start the plain-TCP HTTP listener that answers the /json discovery routes
   * on the CONFIGURED port. Bound loopback-only, same as the ws listener.
   * Non-fatal on failure: the caller (start) logs that discovery is broken and
   * continues, since a direct-ws client can still attach on webSocketPort().
   */
  bool startHttpListener(const std::string& host, uint16_t port);

  /**
   * Set up a newly accepted plain-TCP discovery connection.
   */
  void handleNewHttpConnection(void* nwConnection);

  /**
   * Read request bytes on a discovery connection, accumulating until the header
   * terminator (\r\n\r\n) is seen, then hand off to finishHttpRequest.
   */
  void httpReceiveLoop(ConnectionId connId, void* nwConnection);

  /**
   * Parse the buffered request, build the discovery response via onHttpGet_, and
   * write it back. Cancels the connection only inside the send completion.
   */
  void finishHttpRequest(ConnectionId connId, void* nwConnection,
                         const std::string& request);

  /**
   * Tear down a discovery connection: drop its buffer and cancel the socket.
   */
  void closeHttpConnection(ConnectionId connId, void* nwConnection);

  // State
  mutable std::mutex mutex_;
  std::atomic<bool> running_{false};
  std::atomic<ConnectionId> nextId_{1};

  // Dispatch queue for network I/O
  dispatch_queue_t queue_ = nullptr;

  // Network.framework C objects (nw_listener_t / nw_connection_t).
  // Stored as void* to keep this header free of <Network/Network.h> (it uses Blocks).
  void* listener_ = nullptr;

  // Active connections: id → nw_connection_t
  std::unordered_map<ConnectionId, void*> connections_;

  // Sibling plain-TCP HTTP listener that serves the /json discovery routes on
  // the CONFIGURED port, while the ws listener holds port+1 (see the PORT
  // LAYOUT note in CDPTransportApple.mm for why a second listener rather than
  // same-port byte-sniffing). Stored as void* like listener_.
  void* httpListener_ = nullptr;
  uint16_t httpPort_ = 0;

  // Per-connection accumulated request bytes for the discovery listener, guarded
  // by mutex_ alongside connections_.
  std::unordered_map<ConnectionId, std::shared_ptr<std::string>> httpBuffers_;
};

} // namespace rill::devtools

#endif // __APPLE__
