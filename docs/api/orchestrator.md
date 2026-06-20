# Orchestrator API Reference

The Orchestrator is a native C++ multi-tenant sandbox manager exposed to the host JS runtime via JSI (JavaScript Interface). It provides tenant lifecycle management, per-tenant resource quotas and permission enforcement, cross-tenant communication via an EventBus, and native thread-level isolation.

---

## Engine Integration

Rill integrates Orchestrator via `EngineOptions.sandbox = 'orchestrator'` (or auto-detection). Internally, `Engine` delegates sandbox operations to the native `__RillOrchestrator` HostObject through an internal TypeScript adapter (`src/host/orchestrator/orchestrator-provider.ts`), but this adapter is not part of the public API.

### Detection

The native Orchestrator is installed as a global on the host JS runtime:

```typescript
globalThis.__RillOrchestrator: RillOrchestratorJSI | undefined
```

If `globalThis.__RillOrchestrator` is defined, Orchestrator is available.

### Usage

The Orchestrator is selected automatically when detected, or explicitly via the `sandbox` option:

```typescript
// Auto-detection (used when __RillOrchestrator is available)
const engine = new Engine();

// Explicit selection
const engine = new Engine({
  sandbox: 'orchestrator',
  orchestrator: {
    appId: 'com.example.miniapp',
    quota: { maxHeapBytes: 16 * 1024 * 1024 },
  },
});
```

---

## RillOrchestratorJSI

The full JSI interface for the native `__RillOrchestrator` HostObject. All methods are synchronous JSI calls unless otherwise noted.

### Tenant Lifecycle

#### createTenant(config)

Create a new isolated tenant with its own JS runtime and dedicated thread.

```typescript
createTenant(config: OrchestratorTenantConfig): number
```

Returns a tenant ID (integer) used for all subsequent operations on this tenant.

#### destroyTenant(tenantId)

Destroy a tenant, releasing its JS runtime, thread, and all associated resources.

```typescript
destroyTenant(tenantId: number): void
```

#### pauseTenant(tenantId)

Pause a tenant. Freezes its timers and suspends event delivery.

```typescript
pauseTenant(tenantId: number): void
```

#### resumeTenant(tenantId)

Resume a paused tenant. Unfreezes timers and flushes queued events.

```typescript
resumeTenant(tenantId: number): void
```

### Code Loading

#### loadBundle(tenantId, code)

Load and execute a Guest bundle in the tenant's sandbox.

```typescript
loadBundle(tenantId: number, code: string): void
```

### Communication

#### sendEvent(tenantId, name, payload?)

Send an event to a specific tenant.

```typescript
sendEvent(tenantId: number, name: string, payload?: unknown): void
```

#### broadcast(name, payload?)

Broadcast an event to all active tenants.

```typescript
broadcast(name: string, payload?: unknown): void
```

### Host Callbacks

#### setHostCallbacks(callbacks)

Register callbacks for events flowing from native tenants to the host JS runtime.

```typescript
setHostCallbacks(callbacks: OrchestratorHostCallbacks): void
```

**OrchestratorHostCallbacks:**

| Callback | Signature | Description |
|---|---|---|
| `onBatch` | `(tenantId: number, batch: unknown) => void` | Operation batch from a tenant's reconciler. |
| `onEvent` | `(tenantId: number, name: string, payload: unknown) => void` | Custom event from a tenant. |
| `onError` | `(tenantId: number, message: string) => void` | Error from a tenant. |
| `onLog` | `(tenantId: number, level: string, message: string) => void` | Log message from a tenant. |
| `onTimer` | `(tenantId: number, callbackId: string) => void` | Timer callback from a tenant. |

### Metrics

#### getTenantInfo(tenantId)

Get detailed information about a specific tenant.

```typescript
getTenantInfo(tenantId: number): OrchestratorTenantInfo
```

#### getMetrics()

Get aggregate metrics across all tenants.

```typescript
getMetrics(): OrchestratorMetrics
```

### Per-Tenant Context

#### evalInTenant(tenantId, code)

Evaluate JavaScript code in a tenant's sandbox context.

```typescript
evalInTenant(tenantId: number, code: string): unknown
```

#### setTenantGlobal(tenantId, name, value)

Set a global variable in a tenant's sandbox context.

```typescript
setTenantGlobal(tenantId: number, name: string, value: unknown): void
```

#### getTenantGlobal(tenantId, name)

Get a global variable from a tenant's sandbox context.

```typescript
getTenantGlobal(tenantId: number, name: string): unknown
```

### Per-Tenant Timers

Timers run on the tenant's dedicated native thread, ensuring accurate timing even when the host JS thread is busy.

#### scheduleTenantTimeout(tenantId, callbackId, delayMs)

Schedule a one-shot timeout on the tenant's thread.

```typescript
scheduleTenantTimeout(tenantId: number, callbackId: string, delayMs: number): number
```

Returns a native timer ID for cancellation.

#### scheduleTenantInterval(tenantId, callbackId, intervalMs)

Schedule a repeating interval on the tenant's thread.

```typescript
scheduleTenantInterval(tenantId: number, callbackId: string, intervalMs: number): number
```

Returns a native timer ID for cancellation.

#### cancelTenantTimer(tenantId, timerId)

Cancel a previously scheduled timeout or interval.

```typescript
cancelTenantTimer(tenantId: number, timerId: number): void
```

#### pauseTenantTimers(tenantId)

Pause all timers for a tenant (clock freeze).

```typescript
pauseTenantTimers(tenantId: number): void
```

#### resumeTenantTimers(tenantId)

Resume all timers for a tenant (continue from remaining time).

```typescript
resumeTenantTimers(tenantId: number): void
```

### Permission and Quota

#### canUseComponent(tenantId, componentName)

Check if a tenant is allowed to use a specific component.

```typescript
canUseComponent(tenantId: number, componentName: string): boolean
```

#### canUseAPI(tenantId, apiName)

Check if a tenant is allowed to use a specific API.

```typescript
canUseAPI(tenantId: number, apiName: string): boolean
```

#### isOverQuota(tenantId)

Check if a tenant has exceeded its resource quota.

```typescript
isOverQuota(tenantId: number): boolean
```

#### isNearQuota(tenantId)

Check if a tenant is approaching its resource quota (warning threshold).

```typescript
isNearQuota(tenantId: number): boolean
```

### EventBus

The EventBus enables cross-tenant communication through named channels with configurable policies.

#### busPublish(event)

Publish an event to the EventBus. Delivered to all subscribers on the event's channel.

```typescript
busPublish(event: BusEventData): boolean
```

Returns `true` if the event was accepted.

#### busBroadcast(channel, name, payload)

Broadcast a system event to all subscribers on a channel.

```typescript
busBroadcast(channel: string, name: string, payload: string): boolean
```

#### busUnicast(targetTenantId, channel, name, payload)

Send an event to a specific tenant on a channel.

```typescript
busUnicast(targetTenantId: number, channel: string, name: string, payload: string): boolean
```

#### busMulticast(targetTenantIds, channel, name, payload)

Send an event to a set of specific tenants on a channel.

```typescript
busMulticast(targetTenantIds: number[], channel: string, name: string, payload: string): boolean
```

#### busSubscribe(tenantId, channel, filter)

Subscribe a tenant to events on a channel with an optional name filter (regex string).

```typescript
busSubscribe(tenantId: number, channel: string, filter: string): number
```

Returns a subscription ID for later unsubscription.

#### busUnsubscribe(subscriptionId)

Cancel a specific subscription.

```typescript
busUnsubscribe(subscriptionId: number): void
```

#### busUnsubscribeAll(tenantId)

Cancel all subscriptions for a tenant.

```typescript
busUnsubscribeAll(tenantId: number): void
```

#### busGetStats()

Get EventBus statistics.

```typescript
busGetStats(): EventBusStats
```

#### busCreateChannel(policy)

Create a channel with a specific policy configuration.

```typescript
busCreateChannel(policy: ChannelPolicyConfig): void
```

---

## Type Definitions

### OrchestratorTenantConfig

Configuration for creating a new tenant.

```typescript
interface OrchestratorTenantConfig {
  /** Unique application identifier for this tenant. */
  appId: string;

  /** Enable debug logging for this tenant. */
  debug?: boolean;

  /** Execution timeout in milliseconds. */
  timeout?: number;

  /** Resource quotas for this tenant. */
  quota?: {
    /** Maximum heap memory in bytes. */
    maxHeapBytes?: number;

    /** Maximum number of active timers. */
    maxTimers?: number;

    /** Maximum number of registered callbacks. */
    maxCallbacks?: number;
  };

  /** API whitelist. Empty array means allow all. */
  apis?: string[];
}
```

### OrchestratorTenantInfo

Detailed information about a tenant, returned by `getTenantInfo()`.

```typescript
interface OrchestratorTenantInfo {
  /** Tenant ID. */
  id: number;

  /** Application identifier. */
  appId: string;

  /** Tenant state (numeric enum from native). */
  state: number;

  /** Whether the tenant has been disposed. */
  disposed: boolean;

  /** Current resource usage and limits. */
  quota: {
    activeTimers: number;
    maxTimers: number;
    activeCallbacks: number;
    maxCallbacks: number;
    currentHeapBytes: number;
    maxHeapBytes: number;
  };

  /** Violation counters. */
  violations: {
    /** Number of times a denied component was accessed. */
    componentDenied: number;
    /** Number of times a denied API was accessed. */
    apiDenied: number;
    /** Number of times a quota limit was exceeded. */
    quotaExceeded: number;
  };

  /** Whether the tenant is currently over its resource quota. */
  overQuota: boolean;

  /** Whether the tenant is near its resource quota (warning threshold). */
  nearQuota: boolean;
}
```

### OrchestratorMetrics

Aggregate metrics across all tenants, returned by `getMetrics()`.

```typescript
interface OrchestratorMetrics {
  /** Total number of tenants ever created. */
  totalTenants: number;

  /** Total entries in the tenant registry. */
  registryTotal: number;

  /** Active (non-disposed) tenants in the registry. */
  registryActive: number;

  /** Number of tenants in the running state. */
  running: number;

  /** Number of tenants in the paused state. */
  paused: number;

  /** Number of tenants in the error state. */
  error: number;

  /** Number of active native threads. */
  activeThreads: number;
}
```

### EventBus Types

#### EventPriority

Priority levels for EventBus events. Higher priority events are delivered first.

```typescript
enum EventPriority {
  Critical = 0,
  High     = 1,
  Normal   = 2,
  Low      = 3,
}
```

#### BusEventData

A cross-tenant bus event.

```typescript
interface BusEventData {
  /** Channel name. */
  channel: string;

  /** Event name. */
  name: string;

  /** JSON-serialized payload. */
  payload: string;

  /** Event priority. Defaults to Normal. */
  priority?: EventPriority;

  /** Source tenant ID. 0 indicates a system event. */
  sourceTenantId?: number;
}
```

#### ChannelPolicyConfig

Policy configuration for an EventBus channel.

```typescript
interface ChannelPolicyConfig {
  /** Channel name. */
  name: string;

  /** If true, only system (host) code can publish to this channel. */
  systemOnly?: boolean;

  /** If true, tenants need explicit permission to subscribe. */
  requirePermission?: boolean;

  /** Maximum number of subscribers allowed on this channel. */
  maxSubscribers?: number;

  /** Rate limit: maximum events per second on this channel. */
  maxEventsPerSecond?: number;

  /** Maximum payload size in bytes. */
  maxPayloadBytes?: number;

  /** If true, events are persisted and replayed to new subscribers. */
  persistent?: boolean;
}
```

#### EventBusStats

EventBus statistics, returned by `busGetStats()`.

```typescript
interface EventBusStats {
  /** Total number of events published. */
  totalPublished: number;

  /** Total number of events successfully delivered. */
  totalDelivered: number;

  /** Total number of events dropped (rate limit, quota, etc.). */
  totalDropped: number;

  /** Current number of active subscriptions. */
  activeSubscriptions: number;

  /** Current number of active channels. */
  activeChannels: number;
}
```
