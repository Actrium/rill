// WIP subsystem — gated behind RILL_WIP_NATIVE_SECURITY (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in security/SecurityManager.h.
#if RILL_WIP_NATIVE_SECURITY
#include "SecurityManager.h"

namespace rill::security {

void SecurityManager::createSecurityContext(uint32_t tenantId,
                                             const SecurityPolicy& policy) {
  std::unique_lock lock(mutex_);

  // Clean up any existing context for this tenantId to prevent leaks
  auto existing = contexts_.find(tenantId);
  if (existing != contexts_.end()) {
    if (existing->second.fileSandbox) {
      existing->second.fileSandbox->cleanup(false);
    }
    contexts_.erase(existing);
  }

  TenantSecurityContext ctx;
  ctx.enforced = policy.enforced;

  if (policy.enforced) {
    ctx.networkSandbox =
        std::make_shared<NetworkSandbox>(policy.networkPolicy);
    ctx.fileSandbox =
        std::make_shared<FileSandbox>(tenantId, policy.filePolicy);
  }

  contexts_[tenantId] = std::move(ctx);
}

void SecurityManager::destroySecurityContext(uint32_t tenantId) {
  std::unique_lock lock(mutex_);
  auto it = contexts_.find(tenantId);
  if (it != contexts_.end()) {
    // Cleanup file sandbox before destroying.
    if (it->second.fileSandbox) {
      it->second.fileSandbox->cleanup(false);
    }
    contexts_.erase(it);
  }
}

std::shared_ptr<NetworkSandbox> SecurityManager::getNetworkSandbox(uint32_t tenantId) {
  std::shared_lock lock(mutex_);
  auto it = contexts_.find(tenantId);
  if (it == contexts_.end() || !it->second.enforced) return nullptr;
  return it->second.networkSandbox;
}

std::shared_ptr<FileSandbox> SecurityManager::getFileSandbox(uint32_t tenantId) {
  std::shared_lock lock(mutex_);
  auto it = contexts_.find(tenantId);
  if (it == contexts_.end() || !it->second.enforced) return nullptr;
  return it->second.fileSandbox;
}

bool SecurityManager::hasSecurityContext(uint32_t tenantId) const {
  std::shared_lock lock(mutex_);
  return contexts_.count(tenantId) > 0;
}

size_t SecurityManager::activeContextCount() const {
  std::shared_lock lock(mutex_);
  return contexts_.size();
}

SecurityManager::GlobalAuditReport SecurityManager::getAuditReport() const {
  std::shared_lock lock(mutex_);
  GlobalAuditReport report;

  for (const auto& [tenantId, ctx] : contexts_) {
    if (ctx.networkSandbox) {
      report.networkStats[tenantId] = ctx.networkSandbox->getStats();
      auto audit = ctx.networkSandbox->getRecentAudit(10);
      report.networkAudit.insert(report.networkAudit.end(), audit.begin(),
                                  audit.end());
    }
    if (ctx.fileSandbox) {
      report.fileUsage[tenantId] = ctx.fileSandbox->usedBytes();
    }
  }

  return report;
}

} // namespace rill::security
#endif // RILL_WIP_NATIVE_SECURITY
