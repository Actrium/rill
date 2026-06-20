#pragma once
#include "FileSandbox.h"
#include "NetworkSandbox.h"
#include <cstdint>
#include <memory>
#include <shared_mutex>
#include <unordered_map>
#include <vector>

namespace rill::security {

/// Unified security policy for creating a tenant's security context.
struct SecurityPolicy {
  NetworkPolicy networkPolicy;
  FilePolicy filePolicy;
  bool enforced = true;  // false = bypass all checks (dev mode)
};

/// Manages per-tenant NetworkSandbox + FileSandbox lifecycle.
class SecurityManager {
public:
  SecurityManager() = default;

  /// Create security sandboxes for a tenant.
  void createSecurityContext(uint32_t tenantId, const SecurityPolicy& policy);

  /// Destroy security context (cleanup files, release memory).
  void destroySecurityContext(uint32_t tenantId);

  /// Get network sandbox (nullptr if not created or not enforced).
  /// Returns shared_ptr for safe concurrent access — caller holds a ref
  /// even if destroySecurityContext runs concurrently.
  std::shared_ptr<NetworkSandbox> getNetworkSandbox(uint32_t tenantId);

  /// Get file sandbox (nullptr if not created or not enforced).
  std::shared_ptr<FileSandbox> getFileSandbox(uint32_t tenantId);

  /// Check if a tenant has a security context.
  bool hasSecurityContext(uint32_t tenantId) const;

  /// Get count of active security contexts.
  size_t activeContextCount() const;

  /// Global audit report.
  struct GlobalAuditReport {
    std::vector<NetworkAuditEntry> networkAudit;
    std::unordered_map<uint32_t, NetworkSandbox::Stats> networkStats;
    std::unordered_map<uint32_t, size_t> fileUsage;
  };
  GlobalAuditReport getAuditReport() const;

private:
  struct TenantSecurityContext {
    std::shared_ptr<NetworkSandbox> networkSandbox;
    std::shared_ptr<FileSandbox> fileSandbox;
    bool enforced = true;
  };

  std::unordered_map<uint32_t, TenantSecurityContext> contexts_;
  mutable std::shared_mutex mutex_;
};

} // namespace rill::security
