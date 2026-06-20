# Multi-Tenant Mode (Orchestrator)

The Orchestrator is a C++ native module that manages multiple isolated sandboxes within a single application. Each sandbox is called a **tenant** and runs its own guest bundle on a dedicated thread with independent resource quotas, timers, and lifecycle management.

---

## Overview

Multi-tenant mode is designed for applications that need to run several independent guest bundles simultaneously -- for example, rendering multiple dynamic UI cards on the same screen, each authored by a different team or loaded from a different source.

The Orchestrator provides:

- Per-tenant lifecycle management (create, load, pause, resume, destroy).
- Per-tenant resource quotas (heap size, timer count, callback count).
- A native TimerWheel for high-precision timer scheduling without blocking the host.
- An EventBus for cross-tenant and system-level communication.
- Aggregated metrics across all tenants.

---

## Creating Tenants

A tenant is created by passing a configuration object to the Orchestrator:

```ts
interface OrchestratorTenantConfig {
  appId: string;          // Unique identifier for this tenant
  debug?: boolean;        // Enable debug logging (default false)
  timeout?: number;       // Execution timeout in ms (default 5000)
  quota?: {
    maxHeapBytes?: number;    // Default 64 MB
    maxTimers?: number;       // Default 1000
    maxCallbacks?: number;    // Default 10000
  };
  apis?: Record<string, Function>;  // Host APIs injected into this tenant
}
```

```ts
const tenantId = orchestrator.createTenant({
  appId: 'promo-card',
  timeout: 3000,
  quota: {
    maxHeapBytes: 32 * 1024 * 1024,  // 32 MB
    maxTimers: 500,
    maxCallbacks: 5000,
  },
  apis: {
    fetchProductData: async (sku: string) => { /* ... */ },
  },
});
```

---

## Tenant Lifecycle

Each tenant progresses through a well-defined set of states:

```
Created --> Loading --> Running --> Paused --> Running --> Destroying --> Destroyed
                  \                                /
                   -------> Error ----------------->
```

### States

| State | Description |
|---|---|
| `Created` | Tenant allocated, sandbox not yet initialized. |
| `Loading` | Bundle is being fetched and executed inside the sandbox. |
| `Running` | Bundle executed successfully, tenant is active and rendering. |
| `Paused` | Tenant is suspended. Timers are frozen, callbacks are queued. |
| `Error` | An unrecoverable error occurred. The tenant can be destroyed. |
| `Destroying` | Cleanup is in progress (timers cancelled, callbacks drained). |
| `Destroyed` | All resources released. The tenant ID can be reused. |

### Lifecycle Operations

```ts
// Load and start a bundle
await orchestrator.loadBundle(tenantId, bundleSource);

// Pause (e.g., when the screen is backgrounded)
orchestrator.pauseTenant(tenantId);

// Resume
orchestrator.resumeTenant(tenantId);

// Tear down
orchestrator.destroyTenant(tenantId);
```

---

## Resource Quotas

Quotas prevent any single tenant from consuming disproportionate resources.

### Configuration

| Quota | Default | Description |
|---|---|---|
| `maxHeapBytes` | 64 MB | Maximum heap memory the sandbox may allocate. |
| `maxTimers` | 1000 | Maximum active timers (`setTimeout` / `setInterval`). |
| `maxCallbacks` | 10000 | Maximum registered callback handles. |

### Monitoring

```ts
const info = orchestrator.getTenantInfo(tenantId);
// { appId, state, heapUsed, timerCount, callbackCount, ... }

orchestrator.isOverQuota(tenantId);   // true if any limit exceeded
orchestrator.isNearQuota(tenantId);   // true if any limit > 80%
```

### Violation Tracking

The Orchestrator records quota and policy violations per tenant:

| Violation Type | Trigger |
|---|---|
| `componentDenied` | Guest attempted to render a component not in the allowed set. |
| `apiDenied` | Guest called a host API not provided in `apis`. |
| `quotaExceeded` | A resource quota was exceeded. |

Violations are available via `getTenantInfo(tenantId).violations`.

---

## Timer Management

Each tenant has its own native **TimerWheel** running on the tenant's dedicated thread. This avoids contention with the host's main thread and provides microsecond-precision scheduling.

### API

```ts
// One-shot timer
orchestrator.scheduleTenantTimeout(tenantId, callback, delayMs);

// Repeating timer
orchestrator.scheduleTenantInterval(tenantId, callback, intervalMs);

// Cancel a specific timer
orchestrator.cancelTenantTimer(tenantId, timerId);

// Pause all timers for a tenant (called automatically on pauseTenant)
orchestrator.pauseTenantTimers(tenantId);

// Resume all timers (called automatically on resumeTenant)
orchestrator.resumeTenantTimers(tenantId);
```

When a tenant is paused, its timers freeze. Elapsed time during the pause does not count toward pending timeouts.

---

## Cross-Tenant Communication (EventBus)

The EventBus allows tenants (and the host) to exchange messages through named channels.

### Publishing

```ts
// Publish to a specific channel (delivered to all subscribers)
orchestrator.busPublish(channel, payload);

// Broadcast to all tenants on all channels
orchestrator.busBroadcast(payload);

// Send to a single tenant
orchestrator.busUnicast(tenantId, channel, payload);

// Send to a set of tenants
orchestrator.busMulticast([tenantIdA, tenantIdB], channel, payload);
```

### Channel Policies

Each channel can be configured with a policy object:

| Policy | Type | Description |
|---|---|---|
| `systemOnly` | `boolean` | Only the host can publish to this channel. |
| `requirePermission` | `boolean` | Tenants must be granted explicit access. |
| `maxSubscribers` | `number` | Maximum concurrent subscribers. |
| `maxEventsPerSecond` | `number` | Rate limit for published events. |
| `maxPayloadBytes` | `number` | Maximum serialized payload size. |
| `persistent` | `boolean` | New subscribers receive the last published event. |

### Built-in Channels

| Channel | Direction | Description |
|---|---|---|
| `system` | Host to tenants | System-level notifications (memory warnings, etc.). |
| `lifecycle` | Host to tenants | App lifecycle events (foreground, background). |
| `network.status` | Host to tenants | Network connectivity changes. |
| `tenant.messages` | Tenant to tenant | General-purpose inter-tenant messaging. |

---

## Metrics

The Orchestrator exposes aggregated metrics for monitoring:

```ts
const metrics = orchestrator.getMetrics();
```

```ts
interface OrchestratorMetrics {
  totalTenants: number;     // Total tenants created (including destroyed)
  registryTotal: number;    // Current tenants in registry
  registryActive: number;   // Tenants in Running or Paused state
  running: number;          // Tenants in Running state
  paused: number;           // Tenants in Paused state
  error: number;            // Tenants in Error state
  activeThreads: number;    // OS threads currently in use by tenants
}
```
