// ============================================================================
// WIP — gated behind RILL_WIP_NATIVE_SECURITY (off by default in production).
//
// WHAT THIS IS
//   A native, per-tenant file/network policy stack (defense-in-depth in C++):
//   NetworkSandbox (domain allow/block list, scheme limits, audit) + FileSandbox
//   (path confinement, per-dir read/write + quota) managed per tenant.
//
// WHY IT IS GATED (the security model does NOT live here)
//   The enforced security boundary is two layers, identical on both routes:
//     1. Containment: the JS engine gives the guest ZERO ambient authority.
//        - web:    WASM QuickJS has no fetch/fs/socket/DOM primitives.
//        - native: the JSI sandbox engine (JSC/Hermes/QuickJS as a HostObject)
//                  likewise injects no native fetch/fs/socket — the guest gets
//                  only the __rill dispatch bridge + control-plane globals.
//     2. Mediation: the ONLY way out is the contract capability layer
//        (rill/contract) — declared rpc/subscription capabilities, fail-closed,
//        every guest->host input and host->guest event schema-validated.
//   Guest file/network today flows entirely through TS host modules over that
//   bridge. So this native stack currently guards NO live data path:
//   RillTenantManager builds a context per tenant, but nothing ever calls
//   getFileSandbox()/getNetworkSandbox(). Left ungated it also creates a false
//   impression of enforcement to a reader of RillTenantManager.
//
// WHEN THIS BECOMES REAL (the completion condition)
//   Only if a host module is lowered to native C++ that touches fs/net directly
//   (e.g. a perf-driven native host-store). Then that native path must consult
//   getFileSandbox()/getNetworkSandbox(), and "native enforcement = this stack"
//   becomes a true, symmetric design.
//
// TODO TO COMPLETE
//   1. Introduce the native host-module data path that needs guarding.
//   2. Call getFileSandbox()/getNetworkSandbox() at each native fs/net op.
//   3. Feed SecurityPolicy from the tenant's contract capability manifest so
//      the native layer and the contract layer cannot drift out of sync.
//
// PROCESS / HOW TO BUILD WITH IT
//   Tests always define the flag (native/core/Makefile) so this code keeps
//   compiling. For an evaluation native build:
//     RILL_WIP_NATIVE_SECURITY=1 pod install   (podspec forwards it as -D)
// ============================================================================

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
