#include "TenantContext.h"

namespace rill::orchestrator {

bool TenantContext::canUseComponent(const std::string& name) const {
  return components.allowAll ||
         components.allowedComponents.count(name) > 0;
}

bool TenantContext::canUseAPI(const std::string& api) const {
  return apis.allowAll || apis.allowedAPIs.count(api) > 0;
}

bool TenantContext::canCreateTimer() const {
  return usage.activeTimers.load(std::memory_order_relaxed) <
         quota.maxTimers;
}

bool TenantContext::canRegisterCallback() const {
  return usage.activeCallbacks.load(std::memory_order_relaxed) <
         quota.maxCallbacks;
}

bool TenantContext::canSendBatch() const {
  // Simplified rate check: compare total batches against per-second limit.
  // A production implementation would use a sliding window or token bucket,
  // but for the data-structure layer this threshold check is sufficient.
  return usage.totalBatches.load(std::memory_order_relaxed) <
         static_cast<uint64_t>(quota.maxBatchesPerSecond);
}

bool TenantContext::isOverQuota() const {
  if (usage.currentHeapBytes.load(std::memory_order_relaxed) >
      quota.maxHeapBytes) {
    return true;
  }
  if (usage.activeTimers.load(std::memory_order_relaxed) >
      quota.maxTimers) {
    return true;
  }
  if (usage.activeCallbacks.load(std::memory_order_relaxed) >
      quota.maxCallbacks) {
    return true;
  }
  return false;
}

bool TenantContext::isNearQuota(float threshold) const {
  auto heapBytes = usage.currentHeapBytes.load(std::memory_order_relaxed);
  if (heapBytes >
      static_cast<size_t>(threshold * static_cast<float>(quota.maxHeapBytes))) {
    return true;
  }

  auto timers = usage.activeTimers.load(std::memory_order_relaxed);
  if (timers >
      static_cast<uint32_t>(threshold * static_cast<float>(quota.maxTimers))) {
    return true;
  }

  auto callbacks = usage.activeCallbacks.load(std::memory_order_relaxed);
  if (callbacks > static_cast<uint32_t>(
                      threshold * static_cast<float>(quota.maxCallbacks))) {
    return true;
  }

  return false;
}

}  // namespace rill::orchestrator
