// WIP subsystem — gated behind RILL_WIP_NATIVE_SECURITY (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in security/SecurityManager.h.
#if RILL_WIP_NATIVE_SECURITY
#include "NetworkSandbox.h"
#include <algorithm>
#include <cctype>
#include <chrono>

namespace rill::security {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static double nowSeconds() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

static std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

NetworkSandbox::NetworkSandbox(const NetworkPolicy& policy)
    : policy_(policy) {
  auditLog_.resize(kMaxAuditEntries);
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

std::string NetworkSandbox::extractScheme(const std::string& url) {
  auto pos = url.find("://");
  if (pos == std::string::npos) return "";
  return toLower(url.substr(0, pos));
}

std::string NetworkSandbox::extractHost(const std::string& url) {
  auto schemeEnd = url.find("://");
  if (schemeEnd == std::string::npos) return "";
  auto hostStart = schemeEnd + 3;
  if (hostStart >= url.size()) return "";

  // Skip userinfo (user:pass@)
  auto atPos = url.find('@', hostStart);
  auto slashPos = url.find('/', hostStart);
  if (atPos != std::string::npos &&
      (slashPos == std::string::npos || atPos < slashPos)) {
    hostStart = atPos + 1;
  }

  // Find end of host (port or path)
  auto end = url.find_first_of(":/?#", hostStart);
  if (end == std::string::npos) end = url.size();
  return toLower(url.substr(hostStart, end - hostStart));
}

bool NetworkSandbox::matchesDomain(const std::string& host,
                                    const std::string& pattern) {
  auto h = toLower(host);
  auto p = toLower(pattern);

  if (p.empty() || h.empty()) return false;

  // Exact match.
  if (p == h) return true;

  // Wildcard: "*.example.com" matches "sub.example.com" and
  // "a.b.example.com", but not "example.com" itself.
  if (p.size() > 2 && p[0] == '*' && p[1] == '.') {
    auto suffix = p.substr(1);  // ".example.com"
    // Host must end with the suffix and be longer (has a subdomain).
    if (h.size() > suffix.size() &&
        h.compare(h.size() - suffix.size(), suffix.size(), suffix) == 0) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

std::optional<std::string> NetworkSandbox::validateRequest(
    const NetworkRequest& req) {
  std::lock_guard<std::mutex> lock(mutex_);

  // 1. Scheme check.
  auto scheme = extractScheme(req.url);
  if (scheme.empty()) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Invalid URL: missing scheme";
  }
  if (!policy_.allowInsecureHTTP && scheme == "http") {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Insecure HTTP not allowed";
  }
  if (policy_.allowedSchemes.find(scheme) == policy_.allowedSchemes.end()) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Scheme not allowed: " + scheme;
  }

  // 2. Host extraction + IP rejection.
  auto host = extractHost(req.url);
  if (host.empty()) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Invalid URL: missing host";
  }
  // Reject raw IP addresses (simple heuristic: starts with digit or contains ':' for IPv6).
  if (!host.empty() && (std::isdigit(static_cast<unsigned char>(host[0])) ||
                         host.find(':') != std::string::npos)) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Direct IP addresses not allowed";
  }

  // 3. Blocked domains (checked first).
  for (const auto& pattern : policy_.blockedDomains) {
    if (matchesDomain(host, pattern) || toLower(pattern) == host) {
      blockedRequests_.fetch_add(1, std::memory_order_relaxed);
      return "Domain blocked: " + host;
    }
  }

  // 4. Allowed domains (if list is non-empty, host must match).
  if (!policy_.allowedDomains.empty()) {
    bool allowed = false;
    for (const auto& pattern : policy_.allowedDomains) {
      if (matchesDomain(host, pattern) || toLower(pattern) == host) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      blockedRequests_.fetch_add(1, std::memory_order_relaxed);
      return "Domain not in allowlist: " + host;
    }
  }

  // 5. Forbidden headers.
  for (const auto& [key, _] : req.headers) {
    if (policy_.forbiddenHeaders.count(toLower(key))) {
      blockedRequests_.fetch_add(1, std::memory_order_relaxed);
      return "Forbidden header: " + key;
    }
  }

  // 6. Request body size.
  if (req.bodyBytes > policy_.maxRequestBodyBytes) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Request body too large";
  }

  // 7. Rate limiting.
  if (isRateLimited()) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Rate limit exceeded";
  }

  // 8. Concurrency limiting.
  if (isConcurrencyLimited()) {
    blockedRequests_.fetch_add(1, std::memory_order_relaxed);
    return "Too many concurrent requests";
  }

  // Passed — record timestamp and increment counters.
  requestTimestamps_.push_back(nowSeconds());
  totalRequests_.fetch_add(1, std::memory_order_relaxed);
  concurrentRequests_.fetch_add(1, std::memory_order_relaxed);
  totalBytesOut_.fetch_add(req.bodyBytes, std::memory_order_relaxed);

  return std::nullopt;
}

std::optional<std::string> NetworkSandbox::validateResponse(
    const NetworkRequest& /*req*/, int statusCode, size_t bodyBytes) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (bodyBytes > policy_.maxResponseBodyBytes) {
      return "Response body too large";
    }
  }
  totalBytesIn_.fetch_add(bodyBytes, std::memory_order_relaxed);
  if (statusCode >= 400) {
    failedRequests_.fetch_add(1, std::memory_order_relaxed);
  }
  return std::nullopt;
}

void NetworkSandbox::requestCompleted() {
  auto current = concurrentRequests_.load(std::memory_order_relaxed);
  if (current > 0) {
    concurrentRequests_.fetch_sub(1, std::memory_order_relaxed);
  }
}

// ---------------------------------------------------------------------------
// Rate / concurrency limiting
// ---------------------------------------------------------------------------

bool NetworkSandbox::isRateLimited() {
  // Caller holds mutex_.
  if (policy_.maxRequestsPerMinute == 0) return false;
  auto now = nowSeconds();
  double windowStart = now - 60.0;

  // Purge old entries.
  while (!requestTimestamps_.empty() &&
         requestTimestamps_.front() < windowStart) {
    requestTimestamps_.pop_front();
  }
  return requestTimestamps_.size() >=
         static_cast<size_t>(policy_.maxRequestsPerMinute);
}

bool NetworkSandbox::isConcurrencyLimited() const {
  if (policy_.maxConcurrentRequests == 0) return false;
  return concurrentRequests_.load(std::memory_order_relaxed) >=
         policy_.maxConcurrentRequests;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

void NetworkSandbox::recordAudit(const NetworkAuditEntry& entry) {
  std::lock_guard<std::mutex> lock(mutex_);
  auditLog_[auditLogHead_] = entry;
  auditLogHead_ = (auditLogHead_ + 1) % kMaxAuditEntries;
  if (auditLogSize_ < kMaxAuditEntries) auditLogSize_++;
}

std::vector<NetworkAuditEntry> NetworkSandbox::getRecentAudit(
    size_t limit) const {
  std::lock_guard<std::mutex> lock(mutex_);
  size_t count = std::min(limit, auditLogSize_);
  std::vector<NetworkAuditEntry> result;
  result.reserve(count);

  // Read from newest to oldest.
  for (size_t i = 0; i < count; ++i) {
    size_t idx =
        (auditLogHead_ + kMaxAuditEntries - 1 - i) % kMaxAuditEntries;
    result.push_back(auditLog_[idx]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

NetworkSandbox::Stats NetworkSandbox::getStats() const {
  return {
      totalRequests_.load(std::memory_order_relaxed),
      blockedRequests_.load(std::memory_order_relaxed),
      failedRequests_.load(std::memory_order_relaxed),
      totalBytesIn_.load(std::memory_order_relaxed),
      totalBytesOut_.load(std::memory_order_relaxed),
  };
}

// ---------------------------------------------------------------------------
// Policy update
// ---------------------------------------------------------------------------

void NetworkSandbox::updatePolicy(const NetworkPolicy& policy) {
  std::lock_guard<std::mutex> lock(mutex_);
  policy_ = policy;
}

NetworkPolicy NetworkSandbox::getPolicy() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return policy_;
}

} // namespace rill::security
#endif // RILL_WIP_NATIVE_SECURITY
