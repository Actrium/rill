#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace rill::tenant_manager {

using TenantId = uint32_t;

/// Event priority levels.
enum class EventPriority : uint8_t {
  Critical = 0,  // System-level (OOM, crash warning)
  High = 1,      // User interaction (app state)
  Normal = 2,    // Business events
  Low = 3,       // Diagnostics / logging
};

/// A bus event.
struct BusEvent {
  uint64_t id = 0;
  std::string channel;
  std::string name;
  std::string payload;  // JSON-serialized
  size_t payloadBytes = 0;
  EventPriority priority = EventPriority::Normal;
  double timestamp = 0.0;
  TenantId sourceTenantId = 0;  // 0 = system event

  bool isSystemEvent() const { return sourceTenantId == 0; }
};

/// A subscription handle.
struct Subscription {
  uint64_t id = 0;
  TenantId tenantId = 0;
  std::string channel;
  std::string eventFilter;  // "*" = all, "app.*" = prefix match
  std::function<void(const BusEvent&)> handler;
};

/// Per-channel policy.
struct ChannelPolicy {
  std::string name;
  bool systemOnly = false;         // Only system (tenantId=0) can publish
  bool requirePermission = false;  // Subscribing requires permission check
  uint32_t maxSubscribers = 0;     // 0 = unlimited
  uint32_t maxEventsPerSecond = 0; // 0 = unlimited
  size_t maxPayloadBytes = 64 * 1024;  // 64KB default
  bool persistent = false;         // Buffer events for offline tenants
};

/// Cross-tenant publish/subscribe event bus.
class EventBus {
public:
  EventBus();

  // --- Channel management ---

  void createChannel(const ChannelPolicy& policy);
  void removeChannel(const std::string& name);
  bool hasChannel(const std::string& name) const;
  ChannelPolicy getChannelPolicy(const std::string& name) const;
  std::vector<std::string> channelNames() const;

  // --- Publishing ---

  /// Publish an event to a channel. Returns false if blocked by policy.
  bool publish(BusEvent event);

  /// System broadcast to all subscribers of a channel.
  bool broadcast(const std::string& channel, const std::string& name,
                 const std::string& payload,
                 EventPriority priority = EventPriority::Normal);

  /// Unicast to a specific tenant's subscriptions.
  bool unicast(TenantId targetId, const std::string& channel,
               const std::string& name, const std::string& payload);

  /// Multicast to multiple tenants' subscriptions.
  bool multicast(const std::vector<TenantId>& targetIds,
                 const std::string& channel, const std::string& name,
                 const std::string& payload);

  // --- Subscribing ---

  /// Subscribe to events on a channel matching a filter pattern.
  /// Returns subscription ID, or 0 on failure.
  uint64_t subscribe(TenantId tenantId, const std::string& channel,
                     const std::string& eventFilter,
                     std::function<void(const BusEvent&)> handler);

  /// Cancel a subscription.
  void unsubscribe(uint64_t subscriptionId);

  /// Cancel all subscriptions for a tenant (call on destroyTenant).
  void unsubscribeAll(TenantId tenantId);

  // --- Replay (persistent channels) ---

  /// Get buffered events since a timestamp for replay after tenant resume.
  std::vector<BusEvent> getReplayEvents(const std::string& channel,
                                         double sinceTimestamp) const;

  // --- Stats ---

  struct Stats {
    uint64_t totalPublished = 0;
    uint64_t totalDelivered = 0;
    uint64_t totalDropped = 0;
    size_t activeSubscriptions = 0;
    size_t activeChannels = 0;
  };
  Stats getStats() const;

  // --- Testing helpers ---

  /// Check if an event name matches a filter pattern.
  static bool matchesFilter(const std::string& eventName,
                            const std::string& filter);

private:
  /// Collect matching subscribers while holding lock (copy-then-dispatch pattern).
  std::vector<Subscription> collectSubscribers(
      const std::string& channel, const std::string& eventName);
  std::vector<Subscription> collectSubscribersForTenant(
      TenantId tenantId, const std::string& channel,
      const std::string& eventName);
  /// Dispatch to previously collected subscribers WITHOUT holding lock.
  void dispatchToCollected(const std::vector<Subscription>& subs,
                           const BusEvent& event);
  bool checkChannelRateLimit(const std::string& channel);
  void bufferPersistentEvent(const std::string& channel,
                             const BusEvent& event);

  // Channels.
  std::unordered_map<std::string, ChannelPolicy> channels_;

  // Per-channel rate limiting (timestamps of recent publishes).
  std::unordered_map<std::string, std::deque<double>> channelRateWindows_;

  // Subscriptions indexed by channel.
  std::unordered_map<std::string, std::vector<Subscription>> subscriptions_;

  // Persistent event buffer per channel (ring buffer).
  std::unordered_map<std::string, std::deque<BusEvent>> persistentEvents_;
  static constexpr size_t kMaxPersistentEvents = 100;

  // ID generators.
  std::atomic<uint64_t> nextEventId_{1};
  std::atomic<uint64_t> nextSubscriptionId_{1};

  // Stats.
  std::atomic<uint64_t> totalPublished_{0};
  std::atomic<uint64_t> totalDelivered_{0};
  std::atomic<uint64_t> totalDropped_{0};

  mutable std::shared_mutex mutex_;
};

} // namespace rill::tenant_manager
