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
};

} // namespace rill::devtools

#endif // __APPLE__
