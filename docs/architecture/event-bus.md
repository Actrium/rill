# Event Bus

The Event Bus is a cross-tenant publish/subscribe system implemented in C++. It replaces point-to-point `sendEvent` with a channel-based model that supports system broadcasts, controlled inter-tenant communication, rate limiting, and persistent event buffering.

## Design

**File:** `native/core/src/EventBus.h`

The Event Bus is owned by `RillTenantManager` and shared across all tenants. It provides:

- **Channel-based routing** -- Events are published to named channels, and only subscribers of that channel receive them
- **Policy enforcement** -- Each channel can restrict who can publish, how fast, and how large payloads can be
- **Delivery patterns** -- Broadcast (all subscribers), unicast (single tenant), multicast (multiple tenants)
- **Persistent buffering** -- Selected channels buffer events for replay after tenant resume
- **Thread safety** -- All operations are protected by `std::shared_mutex` using the copy-then-dispatch pattern

## Event Structure

```cpp
struct BusEvent {
  uint64_t id;                    // Auto-assigned unique ID
  std::string channel;            // Channel name
  std::string name;               // Event name within channel
  std::string payload;            // JSON-serialized payload
  size_t payloadBytes;            // Payload size for quota enforcement
  EventPriority priority;         // Critical, High, Normal, Low
  double timestamp;               // Event creation time
  TenantId sourceTenantId;        // 0 = system event
};
```

## Event Priority

| Priority | Value | Use Case |
|---|---|---|
| `Critical` | 0 | System-level alerts (OOM, crash warning) |
| `High` | 1 | App state changes (foreground/background) |
| `Normal` | 2 | Business events |
| `Low` | 3 | Diagnostics, logging |

## Channel Policies

Each channel has a configurable policy that controls access and throughput:

```cpp
struct ChannelPolicy {
  std::string name;
  bool systemOnly;           // Only system (tenantId=0) can publish
  bool requirePermission;    // Subscribing requires explicit permission
  uint32_t maxSubscribers;   // 0 = unlimited
  uint32_t maxEventsPerSecond; // 0 = unlimited
  size_t maxPayloadBytes;    // Default: 64KB
  bool persistent;           // Buffer events for offline tenants
};
```

### Built-in Channels

| Channel | systemOnly | persistent | Description |
|---|---|---|---|
| `system` | yes | yes | System lifecycle events (startup, shutdown, OOM) |
| `lifecycle` | yes | yes | App state transitions (foreground, background, memory warning) |
| `network.status` | yes | no | Network connectivity changes |
| `tenant.messages` | no | no | Tenant-writable inter-tenant messaging (rate-limited) |

## Publishing Operations

### publish(event)

General publish. Enforces channel policy:
1. Check if channel exists
2. Check `systemOnly` restriction
3. Check payload size against `maxPayloadBytes`
4. Check rate limit (`maxEventsPerSecond`)
5. Collect matching subscribers (under lock)
6. Release lock
7. Dispatch to collected subscribers

Returns `false` if blocked by any policy check.

### broadcast(channel, name, payload)

System-wide broadcast to all subscribers of a channel. Sets `sourceTenantId = 0` (system event). Used for app lifecycle events and system notifications.

```cpp
bool broadcast(const std::string& channel,
               const std::string& name,
               const std::string& payload,
               EventPriority priority = EventPriority::Normal);
```

### unicast(targetId, channel, name, payload)

Delivers an event to subscriptions belonging to a single tenant. Only that tenant's handlers on the specified channel are invoked.

```cpp
bool unicast(TenantId targetId,
             const std::string& channel,
             const std::string& name,
             const std::string& payload);
```

### multicast(targetIds, channel, name, payload)

Delivers an event to subscriptions belonging to multiple specified tenants.

```cpp
bool multicast(const std::vector<TenantId>& targetIds,
               const std::string& channel,
               const std::string& name,
               const std::string& payload);
```

## Subscription Management

### subscribe(tenantId, channel, filter, handler)

Register a handler for events on a channel matching a filter pattern.

```cpp
uint64_t subscribe(TenantId tenantId,
                   const std::string& channel,
                   const std::string& eventFilter,
                   std::function<void(const BusEvent&)> handler);
```

Returns a subscription ID (non-zero on success, 0 on failure).

### Event Filter Patterns

- `"*"` -- Match all events on the channel
- `"app.*"` -- Prefix match (matches `app.start`, `app.stop`, `app.config.change`)
- `"user.login"` -- Exact match

The `matchesFilter` function implements pattern matching:
- If the filter is `"*"`, everything matches
- If the filter ends with `".*"`, the event name must start with the prefix before `.*`
- Otherwise, exact string equality is required

### unsubscribe(subscriptionId)

Cancel a single subscription by its ID.

### unsubscribeAll(tenantId)

Cancel all subscriptions for a tenant. Automatically called during `destroyTenant` to prevent dangling handlers.

## Persistent Event Replay

Channels with `persistent = true` buffer events in a ring buffer (`kMaxPersistentEvents = 100`). When a tenant resumes after being paused, it can request replay of events that occurred during the pause:

```cpp
std::vector<BusEvent> getReplayEvents(const std::string& channel,
                                       double sinceTimestamp) const;
```

This returns all buffered events with `timestamp > sinceTimestamp`.

## Implementation: Copy-Then-Dispatch Pattern

To avoid holding the mutex during handler execution (which could deadlock if a handler publishes events or modifies subscriptions), the bus uses a two-phase approach:

1. **Collect phase** (under lock) -- Copy matching `Subscription` objects into a local vector
2. **Dispatch phase** (without lock) -- Iterate the copied vector and invoke each handler

```cpp
// Phase 1: collect (lock held)
auto subs = collectSubscribers(channel, eventName);

// Phase 2: dispatch (lock released)
dispatchToCollected(subs, event);
```

This pattern trades memory (copying subscription data) for safety (no lock during dispatch).

## Rate Limiting

Per-channel rate limiting uses a sliding window of timestamps:

```cpp
std::unordered_map<std::string, std::deque<double>> channelRateWindows_;
```

On each publish, timestamps older than 1 second are removed. If the remaining count exceeds `maxEventsPerSecond`, the event is dropped and counted in `totalDropped`.

## Statistics

```cpp
struct Stats {
  uint64_t totalPublished;        // Events successfully published
  uint64_t totalDelivered;        // Individual handler invocations
  uint64_t totalDropped;          // Events dropped (rate limit, policy)
  size_t activeSubscriptions;     // Currently active subscriptions
  size_t activeChannels;          // Channels with at least one subscriber
};
```

Statistics use `std::atomic` counters for lock-free read access.

## JSI Integration

The Event Bus is exposed to TypeScript through JSI methods on `RillTenantManager`:

| JSI Method | Description |
|---|---|
| `busPublish(opts)` | Publish with full event options |
| `busBroadcast(channel, name, payload)` | System broadcast |
| `busUnicast(targetId, channel, name, payload)` | Single-tenant delivery |
| `busMulticast(targetIds, channel, name, payload)` | Multi-tenant delivery |
| `busSubscribe(tenantId, channel, filter)` | Subscribe (handler routed via onEvent callback) |
| `busUnsubscribe(subscriptionId)` | Cancel subscription |
| `busUnsubscribeAll(tenantId)` | Cancel all for tenant |
| `busGetStats()` | Get statistics |
| `busCreateChannel(policy)` | Create custom channel |
