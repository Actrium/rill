#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace rill::security {

/// Network security policy for a tenant.
struct NetworkPolicy {
  /// Allowed domains (supports wildcard: "*.example.com").
  /// Empty = allow all domains.
  std::vector<std::string> allowedDomains;

  /// Blocked domains (checked before allowed).
  std::vector<std::string> blockedDomains;

  /// Allowed URL schemes.
  std::unordered_set<std::string> allowedSchemes = {"https"};
  bool allowInsecureHTTP = false;

  /// Rate limiting.
  uint32_t maxRequestsPerMinute = 60;
  uint32_t maxConcurrentRequests = 6;
  size_t maxRequestBodyBytes = 1024 * 1024;       // 1MB
  size_t maxResponseBodyBytes = 10 * 1024 * 1024;  // 10MB

  /// Header control.
  std::unordered_set<std::string> forbiddenHeaders = {
      "cookie", "authorization", "x-api-key"};
  std::unordered_map<std::string, std::string> injectedHeaders;
};

/// Network request descriptor for validation.
struct NetworkRequest {
  std::string url;
  std::string method;
  std::unordered_map<std::string, std::string> headers;
  size_t bodyBytes = 0;
  uint32_t tenantId = 0;
  uint64_t requestId = 0;
};

/// Audit log entry.
struct NetworkAuditEntry {
  uint64_t requestId;
  uint32_t tenantId;
  std::string url;
  std::string method;
  int statusCode = 0;
  size_t requestBytes = 0;
  size_t responseBytes = 0;
  double latencyMs = 0.0;
  double timestamp = 0.0;
  std::string error;
  bool blocked = false;
  std::string blockReason;
};

/// Per-tenant network sandbox enforcing URL filtering, rate limiting,
/// header control, and audit logging.
class NetworkSandbox {
public:
  explicit NetworkSandbox(const NetworkPolicy& policy);

  /// Validate a request before sending.
  /// Returns std::nullopt if allowed, or a rejection reason string.
  std::optional<std::string> validateRequest(const NetworkRequest& req);

  /// Validate a response after receiving.
  std::optional<std::string> validateResponse(const NetworkRequest& req,
                                               int statusCode,
                                               size_t bodyBytes);

  /// Record a completed request for audit.
  void recordAudit(const NetworkAuditEntry& entry);

  /// Get recent audit entries (up to limit).
  std::vector<NetworkAuditEntry> getRecentAudit(size_t limit = 100) const;

  /// Aggregated stats.
  struct Stats {
    uint64_t totalRequests = 0;
    uint64_t blockedRequests = 0;
    uint64_t failedRequests = 0;
    size_t totalBytesIn = 0;
    size_t totalBytesOut = 0;
  };
  Stats getStats() const;

  /// Hot-reload policy.
  void updatePolicy(const NetworkPolicy& policy);

  /// Get current policy (for inspection/testing).
  NetworkPolicy getPolicy() const;

  /// Signal that a concurrent request has completed (decrements counter).
  void requestCompleted();

  // --- Internal helpers exposed for testing ---

  /// Check if a URL's domain matches a wildcard pattern.
  static bool matchesDomain(const std::string& host,
                            const std::string& pattern);

  /// Extract scheme from URL (e.g. "https").
  static std::string extractScheme(const std::string& url);

  /// Extract host from URL (e.g. "api.example.com").
  static std::string extractHost(const std::string& url);

private:
  bool isRateLimited();
  bool isConcurrencyLimited() const;

  NetworkPolicy policy_;
  mutable std::mutex mutex_;

  // Sliding window for rate limiting.
  std::deque<double> requestTimestamps_;

  // Audit ring buffer.
  std::vector<NetworkAuditEntry> auditLog_;
  size_t auditLogHead_ = 0;
  size_t auditLogSize_ = 0;
  static constexpr size_t kMaxAuditEntries = 1000;

  // Stats.
  std::atomic<uint64_t> totalRequests_{0};
  std::atomic<uint64_t> blockedRequests_{0};
  std::atomic<uint64_t> failedRequests_{0};
  std::atomic<size_t> totalBytesIn_{0};
  std::atomic<size_t> totalBytesOut_{0};
  std::atomic<uint32_t> concurrentRequests_{0};
};

} // namespace rill::security
