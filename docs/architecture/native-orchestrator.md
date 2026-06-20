# C++ Native Orchestrator

The native orchestrator is a C++ singleton that provides multi-tenant sandbox management, thread isolation, resource quotas, and centralized coordination. It is installed as a JSI HostObject in the React Native host runtime.

## Design Motivation

- **Performance** -- Native C++ avoids TypeScript overhead for hot-path lifecycle management, thread scheduling, and timer operations.
- **Thread Isolation** -- Each tenant gets a dedicated execution thread with its own run loop, ensuring that a slow or runaway guest cannot block other tenants or the host UI thread.
- **Multi-Tenant Coordination** -- Centralized resource tracking, event bus, and security enforcement across all active tenants.

## Component Overview

### RillOrchestrator (`native/core/src/RillOrchestrator.h`)

Singleton installed as `globalThis.__RillOrchestrator` via `jsi::HostObject`. All methods are exposed through the JSI `get()` interface and callable from TypeScript.

Key responsibilities:
- Tenant lifecycle (create, load, pause, resume, destroy)
- Host callback routing (onBatch, onEvent, onError, onLog, onTimer)
- Per-tenant context operations (eval, inject, extract) for TS Engine delegation
- EventBus JSI methods (publish, subscribe, broadcast, unicast, multicast)
- Permission and quota queries
- Metrics collection

### TenantRegistry (`native/core/src/TenantRegistry.h`)

Tracks tenant states and metadata. Provides lookup by `TenantId` and state-based queries (e.g., all running tenants, all paused tenants).

### TenantHandle (`native/core/src/TenantHandle.h`)

Per-tenant wrapper that owns:
- `TenantContext` -- Metadata, resource quotas, state machine
- Sandbox runtime and context (engine-specific: JSC, QuickJS, or Hermes)
- Mutex for thread-safe access

Provides `eval`, `inject`, `extract`, and `dispose` operations that delegate to the underlying sandbox engine.

### TenantThread (`native/core/src/TenantThread.h`)

Dedicated execution thread per tenant. Features:
- Priority queue with four levels: `Immediate`, `High`, `Normal`, `Low`
- FIFO ordering within the same priority (sequence counter)
- `TimerWheel` integration for native timer scheduling
- `post(task, priority)` for async task submission
- `runSync<R>(task)` for synchronous execution with result return (blocks caller)
- Timer delegation: `scheduleTimeout`, `scheduleInterval`, `cancelTimer`, `pauseTimers`, `resumeTimers`

### ThreadPool (`native/core/src/ThreadPool.h`)

Manages tenant thread creation and destruction. Provides thread reuse and orderly shutdown.

### TimerWheel (`native/core/src/TimerWheel.h`)

Per-thread native timer scheduling. Each tenant thread owns a `TimerWheel` that manages `setTimeout` and `setInterval` callbacks without relying on the host's timer infrastructure (which may be stalled in XPC contexts).

## Tenant Lifecycle

### State Machine

```
Created -> Loading -> Running -> Paused -> Destroying -> Destroyed
                        |                      ^
                        +----> Error ----------+
```

### API

| Method | Description |
|---|---|
| `createTenant(config)` | Allocates TenantId, creates TenantHandle + TenantThread |
| `loadBundle(tenantId, code)` | Posts bundle execution task to tenant thread |
| `pauseTenant(tenantId)` | Freezes timers, queues incoming events |
| `resumeTenant(tenantId)` | Unfreezes timers, replays buffered events |
| `destroyTenant(tenantId)` | Cleanup resources, join thread, unsubscribe EventBus |

### Tenant Configuration

```cpp
struct TenantConfig {
  std::string appId;          // Unique application identifier
  ResourceQuota quota;        // Memory, CPU, timer limits
  std::vector<std::string> apis;  // Allowed API capabilities
  bool debug = false;         // Enable debug logging
  double timeout = 0;         // Bundle execution timeout (0 = none)
};
```

## Thread Model

Each tenant owns a thread with:
- **Run Loop** -- Priority-based task queue with condition variable wake-up
- **JS Runtime** -- Isolated sandbox engine instance
- **TimerWheel** -- Native timer scheduling
- **Message Queue** -- Tasks posted from other threads

### Cross-Thread Communication

```
Host VM Thread                    Tenant Thread
     |                                |
     |  TenantThread::post(task)      |
     |  ------------------------------>
     |                                |  (executes task)
     |                                |
     |  CallInvoker::invokeAsync()    |
     <-------------------------------
     |  (delivers result to Host)     |
```

**Critical constraint:** `jsi::Value` objects cannot cross threads. All data passed between threads is serialized as `std::string` (JSON in the default protocol, binary `ArrayBuffer` in the P3 protocol).

### Task Priorities

| Priority | Use Case |
|---|---|
| `Immediate` | Destroy commands, forced cleanup |
| `High` | User-initiated events (onPress, etc.) |
| `Normal` | Bundle execution, timer callbacks |
| `Low` | Diagnostics collection, metrics |

## JSI Binding

The orchestrator is installed in the host runtime during TurboModule initialization:

```cpp
RillOrchestrator::install(hostRuntime, callInvoker);
```

This creates a singleton `RillOrchestrator` and sets it as `globalThis.__RillOrchestrator`. All methods are exposed via the `jsi::HostObject::get()` interface:

```
__RillOrchestrator.createTenant(config)
__RillOrchestrator.loadBundle(tenantId, code)
__RillOrchestrator.destroyTenant(tenantId)
__RillOrchestrator.sendEvent(tenantId, name, payload)
__RillOrchestrator.evalInTenant(tenantId, code)
__RillOrchestrator.setTenantGlobal(tenantId, name, value)
__RillOrchestrator.getTenantGlobal(tenantId, name)
__RillOrchestrator.setHostCallbacks(callbacks)
__RillOrchestrator.getMetrics()
// ... EventBus methods, timer methods, etc.
```

Host callbacks (`onBatch`, `onEvent`, `onError`, `onLog`, `onTimer`) are `jsi::Function` objects registered via `setHostCallbacks`. They are invoked on the Host VM thread via `CallInvoker::invokeAsync()`.

## OrchestratorProvider (TypeScript Adapter)

`src/host/orchestrator/orchestrator-provider.ts` bridges the JSI interface to TypeScript.

### Detection

```typescript
static isAvailable(): boolean {
  return typeof globalThis.__RillOrchestrator !== 'undefined';
}
```

### Engine Integration

When `globalThis.__RillOrchestrator` is available, `Engine` automatically delegates to it. Internally, the adapter wraps the raw JSI interface into a `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope` implementation:

- `createRuntime()` -- Calls `createTenant(config)`, returns a wrapper
- `context.eval(code)` -- Calls `evalInTenant(tenantId, code)`
- `context.inject(name, value)` -- Calls `setTenantGlobal(tenantId, name, value)`
- `context.extract(name)` -- Calls `getTenantGlobal(tenantId, name)`
- `context.dispose()` -- Calls `destroyTenant(tenantId)`

This allows the existing TypeScript Engine code to work transparently whether backed by the C++ orchestrator or a pure-TypeScript sandbox provider.
