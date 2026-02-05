#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_set>

namespace rill::orchestrator {

using TenantId = uint32_t;

enum class TenantState : uint8_t {
  Created,
  Loading,
  Running,
  Paused,
  Error,
  Destroying,
  Destroyed,
};

struct TenantIdentity {
  std::string appId;        // e.g. "com.starbucks.rewards"
  std::string version;      // guest version
  std::string bundleHash;   // integrity check
  std::string environment;  // "production" | "staging" | "development"
};

struct ComponentPermission {
  std::unordered_set<std::string> allowedComponents;
  bool allowAll = false;
};

struct APIPermission {
  std::unordered_set<std::string> allowedAPIs;
  bool allowAll = false;
};

struct ResourceQuota {
  // Memory
  size_t maxHeapBytes = 64 * 1024 * 1024;   // 64MB
  size_t warnHeapBytes = 48 * 1024 * 1024;   // 48MB warning

  // Timers
  uint32_t maxTimers = 1000;
  uint32_t maxIntervalMs = 60 * 60 * 1000;   // 1h max interval

  // Callbacks
  uint32_t maxCallbacks = 10000;

  // Operations
  uint32_t maxOpsPerBatch = 5000;
  uint32_t maxBatchesPerSecond = 60;

  // Events
  uint32_t maxEventQueueSize = 1000;
  uint32_t maxEventPayloadBytes = 1024 * 1024;  // 1MB

  // CPU (optional)
  double maxCpuTimePerFrameMs = 0;  // 0 = unlimited
};

struct ResourceUsage {
  std::atomic<size_t> currentHeapBytes{0};
  std::atomic<uint32_t> activeTimers{0};
  std::atomic<uint32_t> activeCallbacks{0};
  std::atomic<uint64_t> totalOps{0};
  std::atomic<uint64_t> totalBatches{0};
  std::atomic<uint64_t> totalEvents{0};
  std::atomic<uint64_t> droppedEvents{0};

  // Violations
  std::atomic<uint32_t> componentViolations{0};
  std::atomic<uint32_t> apiViolations{0};
  std::atomic<uint32_t> quotaExceeded{0};

  // Non-atomic (updated on tenant thread only)
  double cpuTimeMs = 0;
  double lastFrameStartMs = 0;
};

struct TenantContext {
  TenantIdentity identity;
  ComponentPermission components;
  APIPermission apis;
  ResourceQuota quota;
  ResourceUsage usage;

  TenantState state = TenantState::Created;
  double createdAt = 0;
  double lastActivityAt = 0;

  // Permission checks
  bool canUseComponent(const std::string& name) const;
  bool canUseAPI(const std::string& api) const;

  // Quota checks
  bool canCreateTimer() const;
  bool canRegisterCallback() const;
  bool canSendBatch() const;
  bool isOverQuota() const;
  bool isNearQuota(float threshold = 0.8f) const;
};

}  // namespace rill::orchestrator
