#include "TenantRegistry.h"
#include <chrono>
#include <mutex>
#include <stdexcept>

namespace rill::tenant_manager {

namespace {

// Monotonic timestamp in milliseconds, used for createdAt/lastActivityAt.
double steadyNowMs() {
  auto now = std::chrono::steady_clock::now();
  auto ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          now.time_since_epoch())
          .count();
  return static_cast<double>(ms);
}

}  // namespace

TenantRegistry::TenantRegistry() = default;
TenantRegistry::~TenantRegistry() = default;

TenantId TenantRegistry::registerTenant(TenantIdentity identity,
                                        ComponentPermission components,
                                        APIPermission apis,
                                        ResourceQuota quota) {
  std::unique_lock<std::shared_mutex> lock(mutex_);

  TenantId id = nextId_++;

  auto ctx = std::make_unique<TenantContext>();
  ctx->identity = std::move(identity);
  ctx->components = std::move(components);
  ctx->apis = std::move(apis);
  ctx->quota = quota;
  ctx->state = TenantState::Created;
  ctx->createdAt = steadyNowMs();
  ctx->lastActivityAt = ctx->createdAt;

  const std::string appId = ctx->identity.appId;
  contexts_.emplace(id, std::move(ctx));
  appIdIndex_.emplace(appId, id);

  return id;
}

void TenantRegistry::registerTenantWithId(TenantId id,
                                          TenantIdentity identity,
                                          ComponentPermission components,
                                          APIPermission apis,
                                          ResourceQuota quota) {
  std::unique_lock<std::shared_mutex> lock(mutex_);

  if (contexts_.count(id) > 0) {
    throw std::runtime_error("TenantRegistry id already exists: " +
                             std::to_string(id));
  }

  // Keep the auto-id generator monotonic to avoid future collisions if both
  // modes are used (e.g. tests + TenantManager in the same process).
  if (id >= nextId_) {
    nextId_ = id + 1;
  }

  auto ctx = std::make_unique<TenantContext>();
  ctx->identity = std::move(identity);
  ctx->components = std::move(components);
  ctx->apis = std::move(apis);
  ctx->quota = quota;
  ctx->state = TenantState::Created;
  ctx->createdAt = steadyNowMs();
  ctx->lastActivityAt = ctx->createdAt;

  const std::string appId = ctx->identity.appId;
  contexts_.emplace(id, std::move(ctx));
  appIdIndex_.emplace(appId, id);
}

void TenantRegistry::unregisterTenant(TenantId id) {
  std::unique_lock<std::shared_mutex> lock(mutex_);

  auto it = contexts_.find(id);
  if (it == contexts_.end()) {
    return;
  }

  // Mark as destroyed before removing from index
  it->second->state = TenantState::Destroyed;

  // Remove from appId index
  const std::string& appId = it->second->identity.appId;
  auto range = appIdIndex_.equal_range(appId);
  for (auto rit = range.first; rit != range.second; ++rit) {
    if (rit->second == id) {
      appIdIndex_.erase(rit);
      break;
    }
  }

  contexts_.erase(it);
}

TenantContext* TenantRegistry::getContext(TenantId id) {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  auto it = contexts_.find(id);
  return (it != contexts_.end()) ? it->second.get() : nullptr;
}

const TenantContext* TenantRegistry::getContext(TenantId id) const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  auto it = contexts_.find(id);
  return (it != contexts_.end()) ? it->second.get() : nullptr;
}

TenantContext* TenantRegistry::getContextByAppId(const std::string& appId) {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  auto it = appIdIndex_.find(appId);
  if (it == appIdIndex_.end()) {
    return nullptr;
  }
  auto ctxIt = contexts_.find(it->second);
  return (ctxIt != contexts_.end()) ? ctxIt->second.get() : nullptr;
}

std::vector<TenantId> TenantRegistry::getActiveTenants() const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  std::vector<TenantId> result;
  result.reserve(contexts_.size());
  for (const auto& [id, ctx] : contexts_) {
    if (ctx->state != TenantState::Destroyed) {
      result.push_back(id);
    }
  }
  return result;
}

std::vector<TenantId> TenantRegistry::getTenantsByAppId(
    const std::string& appId) const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  std::vector<TenantId> result;
  auto range = appIdIndex_.equal_range(appId);
  for (auto it = range.first; it != range.second; ++it) {
    result.push_back(it->second);
  }
  return result;
}

void TenantRegistry::updateQuota(TenantId id, const ResourceQuota& quota) {
  std::unique_lock<std::shared_mutex> lock(mutex_);
  auto it = contexts_.find(id);
  if (it != contexts_.end()) {
    it->second->quota = quota;
  }
}

void TenantRegistry::setDefaultQuota(const ResourceQuota& quota) {
  std::unique_lock<std::shared_mutex> lock(mutex_);
  defaultQuota_ = quota;
}

size_t TenantRegistry::totalTenants() const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  return contexts_.size();
}

size_t TenantRegistry::activeTenants() const {
  std::shared_lock<std::shared_mutex> lock(mutex_);
  size_t count = 0;
  for (const auto& [id, ctx] : contexts_) {
    if (ctx->state != TenantState::Destroyed) {
      ++count;
    }
  }
  return count;
}

}  // namespace rill::tenant_manager
