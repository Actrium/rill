#include "EventBus.h"
#include <algorithm>
#include <chrono>

namespace rill::tenant_manager {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static double nowSeconds() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

EventBus::EventBus() = default;

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

bool EventBus::matchesFilter(const std::string& eventName,
                              const std::string& filter) {
  if (filter.empty()) return false;
  if (filter == "*") return true;

  // Prefix wildcard: "app.*" matches "app.state", "app.config.update", etc.
  if (filter.size() >= 2 && filter.back() == '*' &&
      filter[filter.size() - 2] == '.') {
    auto prefix = filter.substr(0, filter.size() - 1);  // "app."
    return eventName.compare(0, prefix.size(), prefix) == 0;
  }

  // Exact match.
  return eventName == filter;
}

// ---------------------------------------------------------------------------
// Channel management
// ---------------------------------------------------------------------------

void EventBus::createChannel(const ChannelPolicy& policy) {
  std::unique_lock lock(mutex_);
  channels_[policy.name] = policy;
}

void EventBus::removeChannel(const std::string& name) {
  std::unique_lock lock(mutex_);
  channels_.erase(name);
  subscriptions_.erase(name);
  persistentEvents_.erase(name);
  channelRateWindows_.erase(name);
}

bool EventBus::hasChannel(const std::string& name) const {
  std::shared_lock lock(mutex_);
  return channels_.count(name) > 0;
}

ChannelPolicy EventBus::getChannelPolicy(const std::string& name) const {
  std::shared_lock lock(mutex_);
  auto it = channels_.find(name);
  if (it == channels_.end()) return {};
  return it->second;
}

std::vector<std::string> EventBus::channelNames() const {
  std::shared_lock lock(mutex_);
  std::vector<std::string> names;
  names.reserve(channels_.size());
  for (const auto& [name, _] : channels_) {
    names.push_back(name);
  }
  std::sort(names.begin(), names.end());
  return names;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

bool EventBus::publish(BusEvent event) {
  std::vector<Subscription> matchedSubs;
  bool persistent = false;

  {
    std::unique_lock lock(mutex_);

    // Check channel exists.
    auto chIt = channels_.find(event.channel);
    if (chIt == channels_.end()) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    const auto& policy = chIt->second;

    // System-only channel: non-system events rejected.
    if (policy.systemOnly && !event.isSystemEvent()) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    // Payload size check.
    if (event.payload.size() > policy.maxPayloadBytes) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    // Rate limiting.
    if (!checkChannelRateLimit(event.channel)) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    // Assign ID and timestamp.
    event.id = nextEventId_.fetch_add(1, std::memory_order_relaxed);
    if (event.timestamp == 0.0) {
      event.timestamp = nowSeconds();
    }
    event.payloadBytes = event.payload.size();

    totalPublished_.fetch_add(1, std::memory_order_relaxed);

    // Buffer if persistent channel.
    persistent = policy.persistent;
    if (persistent) {
      bufferPersistentEvent(event.channel, event);
    }

    // Copy matching subscribers while holding lock, dispatch after release.
    matchedSubs = collectSubscribers(event.channel, event.name);
  }
  // Lock released — safe to call handlers (they may re-enter EventBus).
  dispatchToCollected(matchedSubs, event);
  return true;
}

bool EventBus::broadcast(const std::string& channel, const std::string& name,
                          const std::string& payload,
                          EventPriority priority) {
  BusEvent event;
  event.channel = channel;
  event.name = name;
  event.payload = payload;
  event.priority = priority;
  event.sourceTenantId = 0;  // System event.
  return publish(std::move(event));
}

bool EventBus::unicast(TenantId targetId, const std::string& channel,
                        const std::string& name, const std::string& payload) {
  std::vector<Subscription> matchedSubs;
  BusEvent event;

  {
    std::unique_lock lock(mutex_);

    auto chIt = channels_.find(channel);
    if (chIt == channels_.end()) return false;

    const auto& policy = chIt->second;

    // Enforce channel policies (same as publish).
    if (policy.systemOnly) {
      // unicast is always system-sourced (tenantId=0), so systemOnly is fine.
    }
    if (payload.size() > policy.maxPayloadBytes) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    if (!checkChannelRateLimit(channel)) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    event.id = nextEventId_.fetch_add(1, std::memory_order_relaxed);
    event.channel = channel;
    event.name = name;
    event.payload = payload;
    event.payloadBytes = payload.size();
    event.timestamp = nowSeconds();
    event.sourceTenantId = 0;

    totalPublished_.fetch_add(1, std::memory_order_relaxed);

    if (policy.persistent) {
      bufferPersistentEvent(channel, event);
    }

    // Collect only subscriptions for the target tenant.
    matchedSubs = collectSubscribersForTenant(targetId, channel, name);
  }
  // Lock released — dispatch.
  dispatchToCollected(matchedSubs, event);
  return true;
}

bool EventBus::multicast(const std::vector<TenantId>& targetIds,
                          const std::string& channel, const std::string& name,
                          const std::string& payload) {
  std::vector<Subscription> matchedSubs;
  BusEvent event;

  {
    std::unique_lock lock(mutex_);

    auto chIt = channels_.find(channel);
    if (chIt == channels_.end()) return false;

    const auto& policy = chIt->second;

    // Enforce channel policies.
    if (payload.size() > policy.maxPayloadBytes) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    if (!checkChannelRateLimit(channel)) {
      totalDropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    event.id = nextEventId_.fetch_add(1, std::memory_order_relaxed);
    event.channel = channel;
    event.name = name;
    event.payload = payload;
    event.payloadBytes = payload.size();
    event.timestamp = nowSeconds();
    event.sourceTenantId = 0;

    totalPublished_.fetch_add(1, std::memory_order_relaxed);

    if (policy.persistent) {
      bufferPersistentEvent(channel, event);
    }

    // Collect subscriptions for all target tenants.
    auto it = subscriptions_.find(channel);
    if (it != subscriptions_.end()) {
      for (const auto& sub : it->second) {
        for (auto tid : targetIds) {
          if (sub.tenantId == tid &&
              matchesFilter(name, sub.eventFilter) && sub.handler) {
            matchedSubs.push_back(sub);
            break;  // Don't duplicate for same sub
          }
        }
      }
    }
  }
  // Lock released — dispatch.
  dispatchToCollected(matchedSubs, event);
  return true;
}

// ---------------------------------------------------------------------------
// Dispatch (copy-then-dispatch to avoid deadlock on re-entrant handler calls)
// ---------------------------------------------------------------------------

std::vector<Subscription> EventBus::collectSubscribers(
    const std::string& channel, const std::string& eventName) {
  // Caller holds lock.
  std::vector<Subscription> result;
  auto it = subscriptions_.find(channel);
  if (it == subscriptions_.end()) return result;

  for (const auto& sub : it->second) {
    if (matchesFilter(eventName, sub.eventFilter) && sub.handler) {
      result.push_back(sub);
    }
  }
  return result;
}

std::vector<Subscription> EventBus::collectSubscribersForTenant(
    TenantId tenantId, const std::string& channel,
    const std::string& eventName) {
  // Caller holds lock.
  std::vector<Subscription> result;
  auto it = subscriptions_.find(channel);
  if (it == subscriptions_.end()) return result;

  for (const auto& sub : it->second) {
    if (sub.tenantId == tenantId &&
        matchesFilter(eventName, sub.eventFilter) && sub.handler) {
      result.push_back(sub);
    }
  }
  return result;
}

void EventBus::dispatchToCollected(const std::vector<Subscription>& subs,
                                    const BusEvent& event) {
  // Called WITHOUT holding lock — handlers may safely re-enter EventBus.
  for (const auto& sub : subs) {
    if (sub.handler) {
      sub.handler(event);
      totalDelivered_.fetch_add(1, std::memory_order_relaxed);
    }
  }
}

// ---------------------------------------------------------------------------
// Subscribing
// ---------------------------------------------------------------------------

uint64_t EventBus::subscribe(TenantId tenantId, const std::string& channel,
                              const std::string& eventFilter,
                              std::function<void(const BusEvent&)> handler) {
  std::unique_lock lock(mutex_);

  // Channel must exist.
  auto chIt = channels_.find(channel);
  if (chIt == channels_.end()) return 0;

  const auto& policy = chIt->second;

  // Max subscribers check.
  if (policy.maxSubscribers > 0) {
    auto subIt = subscriptions_.find(channel);
    if (subIt != subscriptions_.end() &&
        subIt->second.size() >= policy.maxSubscribers) {
      return 0;
    }
  }

  Subscription sub;
  sub.id = nextSubscriptionId_.fetch_add(1, std::memory_order_relaxed);
  sub.tenantId = tenantId;
  sub.channel = channel;
  sub.eventFilter = eventFilter;
  sub.handler = std::move(handler);

  subscriptions_[channel].push_back(std::move(sub));
  return sub.id;
}

void EventBus::unsubscribe(uint64_t subscriptionId) {
  std::unique_lock lock(mutex_);
  for (auto& [channel, subs] : subscriptions_) {
    auto it = std::remove_if(subs.begin(), subs.end(),
                              [subscriptionId](const Subscription& s) {
                                return s.id == subscriptionId;
                              });
    if (it != subs.end()) {
      subs.erase(it, subs.end());
      return;
    }
  }
}

void EventBus::unsubscribeAll(TenantId tenantId) {
  std::unique_lock lock(mutex_);
  for (auto& [channel, subs] : subscriptions_) {
    subs.erase(
        std::remove_if(subs.begin(), subs.end(),
                        [tenantId](const Subscription& s) {
                          return s.tenantId == tenantId;
                        }),
        subs.end());
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (per-channel)
// ---------------------------------------------------------------------------

bool EventBus::checkChannelRateLimit(const std::string& channel) {
  // Caller holds lock.
  auto chIt = channels_.find(channel);
  if (chIt == channels_.end()) return true;

  uint32_t maxPerSec = chIt->second.maxEventsPerSecond;
  if (maxPerSec == 0) return true;

  auto now = nowSeconds();
  auto& window = channelRateWindows_[channel];

  // Purge entries older than 1 second.
  while (!window.empty() && window.front() < now - 1.0) {
    window.pop_front();
  }

  if (window.size() >= maxPerSec) return false;
  window.push_back(now);
  return true;
}

// ---------------------------------------------------------------------------
// Persistent events
// ---------------------------------------------------------------------------

void EventBus::bufferPersistentEvent(const std::string& channel,
                                      const BusEvent& event) {
  // Caller holds lock.
  auto& buffer = persistentEvents_[channel];
  buffer.push_back(event);
  while (buffer.size() > kMaxPersistentEvents) {
    buffer.pop_front();
  }
}

std::vector<BusEvent> EventBus::getReplayEvents(
    const std::string& channel, double sinceTimestamp) const {
  std::shared_lock lock(mutex_);
  auto it = persistentEvents_.find(channel);
  if (it == persistentEvents_.end()) return {};

  std::vector<BusEvent> result;
  for (const auto& event : it->second) {
    if (event.timestamp > sinceTimestamp) {
      result.push_back(event);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

EventBus::Stats EventBus::getStats() const {
  std::shared_lock lock(mutex_);
  Stats s;
  s.totalPublished = totalPublished_.load(std::memory_order_relaxed);
  s.totalDelivered = totalDelivered_.load(std::memory_order_relaxed);
  s.totalDropped = totalDropped_.load(std::memory_order_relaxed);
  s.activeChannels = channels_.size();
  size_t subs = 0;
  for (const auto& [_, v] : subscriptions_) {
    subs += v.size();
  }
  s.activeSubscriptions = subs;
  return s;
}

} // namespace rill::tenant_manager
