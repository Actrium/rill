/**
 * NetworkAdapter.h
 *
 * P3-Y.7: Network Domain Adapter
 *
 * Bridges NetworkSandbox audit logs to CDP Network domain events:
 *   - Network.requestWillBeSent
 *   - Network.responseReceived
 *   - Network.loadingFinished
 *   - Network.loadingFailed
 *   - Network.dataReceived
 *
 * Integrates with security/NetworkSandbox.h for request interception.
 */

#pragma once

#include "CDPServer.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <chrono>
#include <functional>

namespace rill::devtools {

// ============================================
// Network Types
// ============================================

/**
 * HTTP request information
 */
struct NetworkRequest {
  std::string requestId;
  std::string url;
  std::string method = "GET";
  std::unordered_map<std::string, std::string> headers;
  std::string postData;
  bool hasPostData = false;
  
  // Timing
  double timestamp = 0;  // Seconds since epoch
  double wallTime = 0;   // Unix timestamp
};

/**
 * HTTP response information
 */
struct NetworkResponse {
  std::string requestId;
  std::string url;
  int status = 200;
  std::string statusText = "OK";
  std::unordered_map<std::string, std::string> headers;
  std::string mimeType;
  
  // Size info
  int64_t encodedDataLength = 0;
  int64_t decodedBodyLength = 0;
  
  // Timing
  double timestamp = 0;
};

/**
 * Resource type
 */
enum class ResourceType {
  Document,
  Stylesheet,
  Image,
  Media,
  Font,
  Script,
  XHR,
  Fetch,
  WebSocket,
  Other
};

inline const char* resourceTypeToString(ResourceType type) {
  switch (type) {
    case ResourceType::Document:   return "Document";
    case ResourceType::Stylesheet: return "Stylesheet";
    case ResourceType::Image:      return "Image";
    case ResourceType::Media:      return "Media";
    case ResourceType::Font:       return "Font";
    case ResourceType::Script:     return "Script";
    case ResourceType::XHR:        return "XHR";
    case ResourceType::Fetch:      return "Fetch";
    case ResourceType::WebSocket:  return "WebSocket";
    default:                       return "Other";
  }
}

/**
 * Request initiator information
 */
struct RequestInitiator {
  std::string type = "other";  // "parser", "script", "other"
  std::string url;
  int lineNumber = 0;
  int columnNumber = 0;
  std::string stack;  // JSON stack trace
};

/**
 * Network error
 */
struct NetworkError {
  std::string requestId;
  std::string errorText;
  bool canceled = false;
  double timestamp = 0;
};

/**
 * Blocked request (by sandbox policy)
 */
struct BlockedRequest {
  std::string requestId;
  std::string url;
  std::string blockedReason;  // "mixed-content", "csp", "policy", etc.
  double timestamp = 0;
};

// ============================================
// Network Adapter
// ============================================

/**
 * CDP Network domain adapter
 */
class NetworkAdapter {
public:
  explicit NetworkAdapter(CDPServer& server);
  ~NetworkAdapter() = default;
  
  // Non-copyable
  NetworkAdapter(const NetworkAdapter&) = delete;
  NetworkAdapter& operator=(const NetworkAdapter&) = delete;
  
  // ============================================
  // CDP Method Handlers
  // ============================================
  
  CDPResponse handleEnable(TenantId tenantId, int requestId, const std::string& params);
  CDPResponse handleDisable(TenantId tenantId, int requestId);
  
  CDPResponse handleGetResponseBody(TenantId tenantId, int requestId, 
                                     const std::string& params);
  CDPResponse handleSetCacheDisabled(TenantId tenantId, int requestId,
                                      const std::string& params);
  CDPResponse handleSetExtraHTTPHeaders(TenantId tenantId, int requestId,
                                         const std::string& params);
  CDPResponse handleGetCookies(TenantId tenantId, int requestId);
  CDPResponse handleClearBrowserCache(TenantId tenantId, int requestId);
  CDPResponse handleClearBrowserCookies(TenantId tenantId, int requestId);
  
  // ============================================
  // Event Emitters (called from NetworkSandbox)
  // ============================================
  
  /**
   * Called when a request is about to be sent
   */
  void onRequestWillBeSent(TenantId tenantId, const NetworkRequest& request,
                           ResourceType type = ResourceType::Fetch,
                           const RequestInitiator& initiator = {});
  
  /**
   * Called when response headers are received
   */
  void onResponseReceived(TenantId tenantId, const NetworkResponse& response,
                          ResourceType type = ResourceType::Fetch);
  
  /**
   * Called when data is received
   */
  void onDataReceived(TenantId tenantId, const std::string& requestId,
                      int64_t dataLength, int64_t encodedDataLength);
  
  /**
   * Called when loading finishes successfully
   */
  void onLoadingFinished(TenantId tenantId, const std::string& requestId,
                         double timestamp, int64_t encodedDataLength);
  
  /**
   * Called when loading fails
   */
  void onLoadingFailed(TenantId tenantId, const NetworkError& error);
  
  /**
   * Called when request is blocked by sandbox policy
   */
  void onRequestBlocked(TenantId tenantId, const BlockedRequest& blocked);
  
  /**
   * Called for WebSocket events
   */
  void onWebSocketCreated(TenantId tenantId, const std::string& requestId,
                          const std::string& url);
  void onWebSocketClosed(TenantId tenantId, const std::string& requestId);
  void onWebSocketFrameSent(TenantId tenantId, const std::string& requestId,
                            const std::string& data, bool isBinary);
  void onWebSocketFrameReceived(TenantId tenantId, const std::string& requestId,
                                 const std::string& data, bool isBinary);
  
  // ============================================
  // Response Body Storage (for getResponseBody)
  // ============================================
  
  /**
   * Store response body for later retrieval
   */
  void storeResponseBody(TenantId tenantId, const std::string& requestId,
                         const std::string& body, bool base64Encoded = false);
  
  /**
   * Clear stored response bodies for tenant
   */
  void clearResponseBodies(TenantId tenantId);

private:
  /**
   * Build request JSON for CDP
   */
  std::string requestToJSON(const NetworkRequest& request);
  
  /**
   * Build response JSON for CDP
   */
  std::string responseToJSON(const NetworkResponse& response);
  
  /**
   * Build initiator JSON for CDP
   */
  std::string initiatorToJSON(const RequestInitiator& initiator);
  
  /**
   * Build headers JSON
   */
  std::string headersToJSON(const std::unordered_map<std::string, std::string>& headers);
  
  /**
   * Get current timestamp in seconds
   */
  static double getCurrentTimestamp();
  
  /**
   * Generate unique request ID
   */
  std::string generateRequestId();
  
  CDPServer& server_;
  
  // Per-tenant state
  struct TenantNetworkState {
    bool enabled = false;
    std::unordered_map<std::string, std::string> extraHeaders;
    bool cacheDisabled = false;
    
    // Stored response bodies
    struct ResponseBody {
      std::string body;
      bool base64Encoded;
    };
    std::unordered_map<std::string, ResponseBody> responseBodies;
  };
  
  std::unordered_map<TenantId, TenantNetworkState> tenantStates_;
  std::mutex stateMutex_;
  
  std::atomic<uint64_t> nextRequestId_{1};
};

// ============================================
// Network Sandbox Integration
// ============================================

/**
 * Callback interface for NetworkSandbox to report events
 */
class INetworkAuditListener {
public:
  virtual ~INetworkAuditListener() = default;
  
  virtual void onRequestStart(TenantId tenantId, const NetworkRequest& request) = 0;
  virtual void onRequestComplete(TenantId tenantId, const NetworkResponse& response,
                                  const std::string& body) = 0;
  virtual void onRequestError(TenantId tenantId, const NetworkError& error) = 0;
  virtual void onRequestBlocked(TenantId tenantId, const BlockedRequest& blocked) = 0;
};

/**
 * Adapter that implements INetworkAuditListener
 */
class NetworkAuditBridge : public INetworkAuditListener {
public:
  explicit NetworkAuditBridge(NetworkAdapter& adapter)
      : adapter_(adapter) {}
  
  void onRequestStart(TenantId tenantId, const NetworkRequest& request) override {
    adapter_.onRequestWillBeSent(tenantId, request);
  }
  
  void onRequestComplete(TenantId tenantId, const NetworkResponse& response,
                          const std::string& body) override {
    adapter_.onResponseReceived(tenantId, response);
    adapter_.storeResponseBody(tenantId, response.requestId, body);
    adapter_.onLoadingFinished(tenantId, response.requestId, 
                               response.timestamp, response.encodedDataLength);
  }
  
  void onRequestError(TenantId tenantId, const NetworkError& error) override {
    adapter_.onLoadingFailed(tenantId, error);
  }
  
  void onRequestBlocked(TenantId tenantId, const BlockedRequest& blocked) override {
    adapter_.onRequestBlocked(tenantId, blocked);
  }

private:
  NetworkAdapter& adapter_;
};

} // namespace rill::devtools
