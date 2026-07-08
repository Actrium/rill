#pragma once
#include "TenantHandle.h"
#include "TenantRegistry.h"
#include "ThreadPool.h"
#include "EventBus.h"
#include "security/SecurityManager.h"
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#if RILL_WIP_CDP_DEVTOOLS
#include "devtools/DevToolsService.h"
#endif

namespace rill::tenant_manager {

/// Configuration passed from JS when creating a tenant.
struct TenantConfig {
  std::string appId;
  ResourceQuota quota;
  std::vector<std::string> apis;
  bool debug = false;
  double timeout = 0; // 0 = no execution timeout
};

/// Callbacks from TenantManager → Host JS.
/// These functions live on the Host VM and must only be called on the JS thread.
struct HostCallbacks {
  std::shared_ptr<facebook::jsi::Function> onBatch;
  std::shared_ptr<facebook::jsi::Function> onEvent;
  std::shared_ptr<facebook::jsi::Function> onError;
  std::shared_ptr<facebook::jsi::Function> onLog;
  std::shared_ptr<facebook::jsi::Function> onTimer; // Timer callback fired from TenantThread
};

/// Native C++ tenant_manager for multi-tenant sandbox management.
/// Installed as `__RillTenantManager` global HostObject in the Host JS runtime.
class RillTenantManager : public facebook::jsi::HostObject {
public:
  /// Install the tenant_manager as a global HostObject on the Host runtime.
  /// Call after sandbox bindings are installed.
  static void install(facebook::jsi::Runtime& hostRuntime,
                      std::shared_ptr<facebook::react::CallInvoker> callInvoker);

  /// Get the singleton instance (available after install).
  static RillTenantManager* instance();

  // jsi::HostObject interface
  facebook::jsi::Value get(facebook::jsi::Runtime& rt,
                           const facebook::jsi::PropNameID& name) override;
  void set(facebook::jsi::Runtime& rt,
           const facebook::jsi::PropNameID& name,
           const facebook::jsi::Value& value) override;
  std::vector<facebook::jsi::PropNameID> getPropertyNames(
      facebook::jsi::Runtime& rt) override;

private:
  RillTenantManager(facebook::jsi::Runtime& hostRuntime,
                   std::shared_ptr<facebook::react::CallInvoker> callInvoker);

  // --- Tenant lifecycle ---
  TenantId createTenant(facebook::jsi::Runtime& rt,
                        const facebook::jsi::Object& config);
  void destroyTenant(TenantId id);
  void pauseTenant(TenantId id);
  void resumeTenant(TenantId id);

  // --- Code loading ---
  void loadBundle(TenantId id, const std::string& code);

  // --- Communication ---
  void sendEvent(TenantId id, const std::string& name,
                 facebook::jsi::Runtime& rt,
                 const facebook::jsi::Value& payload);
  void broadcast(const std::string& name,
                 facebook::jsi::Runtime& rt,
                 const facebook::jsi::Value& payload);

  // --- Host callbacks ---
  void setHostCallbacks(facebook::jsi::Runtime& rt,
                        const facebook::jsi::Object& callbacks);

  // --- Metrics ---
  facebook::jsi::Object getTenantInfo(facebook::jsi::Runtime& rt,
                                      TenantId id);
  facebook::jsi::Object getMetrics(facebook::jsi::Runtime& rt);

  // --- Per-tenant context operations (for TS Engine delegation) ---
  facebook::jsi::Value evalInTenant(facebook::jsi::Runtime& rt,
                                     TenantId id,
                                     const std::string& code);
  void setTenantGlobal(facebook::jsi::Runtime& rt,
                       TenantId id,
                       const std::string& name,
                       const facebook::jsi::Value& value);
  facebook::jsi::Value getTenantGlobal(facebook::jsi::Runtime& rt,
                                        TenantId id,
                                        const std::string& name);

  // --- Per-tenant timer operations (P0.2: managed by TenantThread) ---
  double scheduleTenantTimeout(TenantId id, const std::string& callbackId,
                               double delayMs);
  double scheduleTenantInterval(TenantId id, const std::string& callbackId,
                                double intervalMs);
  void cancelTenantTimer(TenantId id, double timerId);
  void pauseTenantTimers(TenantId id);
  void resumeTenantTimers(TenantId id);

  /// Called on TenantThread when a timer fires. Routes to Host VM thread.
  void onTimerFired(TenantId tenantId, const std::string& callbackId);

  // --- Permission / quota queries (P1: exposed to TS via JSI) ---
  bool canUseComponent(TenantId id, const std::string& name);
  bool canUseAPI(TenantId id, const std::string& api);
  bool isOverQuota(TenantId id);
  bool isNearQuota(TenantId id);

  // --- EventBus JSI methods (P2) ---
  bool busPublish(facebook::jsi::Runtime& rt, const facebook::jsi::Object& opts);
  bool busBroadcast(facebook::jsi::Runtime& rt, const std::string& channel,
                    const std::string& name, const std::string& payload);
  bool busUnicast(TenantId targetId, const std::string& channel,
                  const std::string& name, const std::string& payload);
  bool busMulticast(facebook::jsi::Runtime& rt,
                    const facebook::jsi::Array& targetIds,
                    const std::string& channel, const std::string& name,
                    const std::string& payload);
  double busSubscribe(TenantId tenantId, const std::string& channel,
                      const std::string& filter);
  void busUnsubscribe(double subscriptionId);
  void busUnsubscribeAll(TenantId tenantId);
  facebook::jsi::Object busGetStats(facebook::jsi::Runtime& rt);
  void busCreateChannel(facebook::jsi::Runtime& rt,
                        const facebook::jsi::Object& policy);

  // --- Helpers ---
  TenantConfig parseTenantConfig(facebook::jsi::Runtime& rt,
                                 const facebook::jsi::Object& config);
  TenantHandle* getTenantOrThrow(TenantId id);

  // --- State ---
  facebook::jsi::Runtime* hostRuntime_;
  std::shared_ptr<facebook::react::CallInvoker> callInvoker_;
  HostCallbacks hostCallbacks_;

  std::unordered_map<TenantId, std::unique_ptr<TenantHandle>> tenants_;
  TenantRegistry registry_;
  ThreadPool threadPool_;  // P0.2: per-tenant thread management
  EventBus eventBus_;      // P2: cross-tenant event bus
  rill::security::SecurityManager securityManager_; // P2: per-tenant security
  std::recursive_mutex mutex_;
  std::mutex callbacksMutex_;
  TenantId nextTenantId_ = 1;

#if RILL_WIP_CDP_DEVTOOLS
  // CDP DevTools server (loopback-only), mirroring the tenant lifecycle into
  // CDP target discovery. WIP-gated; absent from shipping builds.
  std::unique_ptr<rill::devtools::DevToolsService> devTools_;
#endif

  static std::shared_ptr<RillTenantManager> instance_;
};

} // namespace rill::tenant_manager
