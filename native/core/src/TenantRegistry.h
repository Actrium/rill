#pragma once
#include "TenantContext.h"
#include <memory>
#include <shared_mutex>
#include <unordered_map>
#include <vector>

namespace rill::tenant_manager {

class TenantRegistry {
 public:
  TenantRegistry();
  ~TenantRegistry();

  // CRUD
  // Auto-allocates an id (useful for unit tests / standalone usage).
  TenantId registerTenant(TenantIdentity identity,
                          ComponentPermission components = {},
                          APIPermission apis = {},
                          ResourceQuota quota = {});

  // Register a tenant with a caller-provided id (used by TenantManager).
  // Throws if the id already exists.
  void registerTenantWithId(TenantId id,
                            TenantIdentity identity,
                            ComponentPermission components = {},
                            APIPermission apis = {},
                            ResourceQuota quota = {});
  void unregisterTenant(TenantId id);

  // Lookup
  TenantContext* getContext(TenantId id);
  const TenantContext* getContext(TenantId id) const;
  TenantContext* getContextByAppId(const std::string& appId);

  // Enumerate
  std::vector<TenantId> getActiveTenants() const;
  std::vector<TenantId> getTenantsByAppId(const std::string& appId) const;

  // Quota management
  void updateQuota(TenantId id, const ResourceQuota& quota);
  void setDefaultQuota(const ResourceQuota& quota);

  // Stats
  size_t totalTenants() const;
  size_t activeTenants() const;

 private:
  std::unordered_map<TenantId, std::unique_ptr<TenantContext>> contexts_;
  std::unordered_multimap<std::string, TenantId> appIdIndex_;
  ResourceQuota defaultQuota_;
  mutable std::shared_mutex mutex_;
  uint32_t nextId_ = 1;
};

}  // namespace rill::tenant_manager
