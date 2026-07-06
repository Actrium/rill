# Production Deployment

This guide covers the configuration, hardening, monitoring, and optimization practices for deploying Rill in a production environment.

---

## Runtime Hardening

### Module Whitelist

The `requireWhitelist` option restricts which modules guest code may import. Any `require()` or `import` call targeting a module not in the list throws a `RequireError`.

```ts
const engine = new Engine({
  requireWhitelist: [
    'react',
    'react-native',
    'react/jsx-runtime',
    'rill/guest',
    'rill/*',
  ],
  // ...
});
```

The default whitelist includes the entries above. The `rill/*` pattern matches all `rill/` sub-paths.

### Execution Timeout

The `timeout` option sets the maximum wall-clock time (in milliseconds) a guest bundle may spend during initial evaluation or any single synchronous call from the host.

```ts
const engine = new Engine({
  timeout: 5000, // default
  // ...
});
```

Enforcement is engine-specific: the QuickJS and Hermes (JSI) providers abort a runaway eval with a hard wall-clock interrupt; JSC has no public interrupt API and does not enforce the timeout — see [Sandbox Comparison](../reference/sandbox-comparison.md) for the full matrix.

### Error Classification

Rill categorizes sandbox errors into well-defined types:

| Error Class | Meaning |
|---|---|
| `RequireError` | Guest attempted to import a module not in the whitelist. |
| `ExecutionError` | Uncaught exception during bundle evaluation or callback invocation. |
| `TimeoutError` | Execution exceeded the configured timeout. |

All error types include the original stack trace (when available) and the engine instance ID for correlation.

### Batch Limits

The receiver processes UI instructions from the sandbox in batches. The `receiverMaxBatchSize` option caps the number of instructions processed in a single batch to prevent the host thread from being blocked by a misbehaving guest.

```ts
const engine = new Engine({
  receiverMaxBatchSize: 5000, // default
  // ...
});
```

---

## Metrics & Observability

### onMetric Callback

Pass an `onMetric` callback to receive timing and count data for key engine operations:

```ts
const engine = new Engine({
  onMetric: (name: string, value: number, tags?: Record<string, string>) => {
    telemetry.record(name, value, tags);
  },
  // ...
});
```

#### Metric Names

| Metric | Unit | Description |
|---|---|---|
| `engine.resolveSource` | ms | Time to resolve the bundle source (URL resolution, cache lookup). |
| `engine.fetchBundle` | ms | Time to fetch the bundle content over the network. |
| `engine.initializeRuntime` | ms | Time to create and configure the sandbox runtime. |
| `engine.executeBundle` | ms | Time to evaluate the guest bundle inside the sandbox. |
| `engine.sendToSandbox` | ms | Time for a single host-to-sandbox message round-trip. |
| `receiver.applyBatch` | ms | Time to apply one batch of UI instructions on the host. |
| `receiver.render` | ms | Time for the host reconciler to commit a render pass. |

### Structured Logger

The `logger` option accepts a structured logger object for engine-level log output:

```ts
const engine = new Engine({
  logger: {
    debug: (msg, data) => { /* ... */ },
    info:  (msg, data) => { /* ... */ },
    warn:  (msg, data) => { /* ... */ },
    error: (msg, data) => { /* ... */ },
  },
  // ...
});
```

---

## Health Check API

All health and resource data is exposed through a single method, `engine.getDiagnostics()`, which returns an `EngineDiagnostics` snapshot.

### Engine Health

```ts
const { health } = engine.getDiagnostics();
```

```ts
interface EngineHealth {
  loaded: boolean;             // true if a bundle has been successfully loaded
  destroyed: boolean;          // true if engine.destroy() has been called
  errorCount: number;          // total errors since creation
  lastErrorAt: number | null;  // timestamp (ms) of the most recent error, or null
  receiverNodes: number;       // current number of nodes tracked by the receiver
  batching: boolean;           // whether operation batching is active
}
```

### Resource Stats

```ts
const { resources } = engine.getDiagnostics();
```

```ts
interface ResourceStats {
  timers: number;      // active setTimeout / setInterval handles
  nodes: number;       // live UI nodes in the receiver tree
  callbacks: number;   // registered callback handles
}
```

Use this snapshot to build liveness probes or dashboard panels that surface sandbox health alongside your application metrics.

---

## Security Isolation

### Sandbox Provider Selection

Choose a sandbox backend with the appropriate isolation level for your deployment target (via `EngineOptions.sandbox`). See the [Sandbox Providers](./sandbox-providers.md) guide for a full comparison. In production mobile deployments, prefer JSC Native, Hermes Native, or QuickJS Native for full process-level isolation.

### Module Access Whitelist

Always keep the `requireWhitelist` as narrow as possible. Do not add modules to the whitelist unless the guest bundle explicitly depends on them.

### Callback Payload Validation

Data returned from the sandbox through callbacks is validated against the engine's `TypeRules` before being forwarded to host code. Circular references, functions, and other non-serializable values are rejected.

---

## Performance Optimization

### ThrottledScheduler

The engine uses a `ThrottledScheduler` internally to coalesce rapid sequences of UI updates into fewer reconciliation passes. This reduces the number of synchronous bridge crossings and keeps the host thread responsive.

### OperationMerger

Consecutive operations on the same node (for example, multiple `setProp` calls) are merged into a single instruction before dispatch. This is transparent to the guest code and reduces instruction batch sizes.

### FlatList Virtualization

When guest code renders large scrollable lists, the host-side `FlatList` component applies standard React Native virtualization. Only the visible window of items is mounted, keeping node counts and memory usage bounded regardless of list length.

---

## Memory Management

### Destroying the Engine

Always call `engine.destroy()` when the engine instance is no longer needed. This releases the sandbox runtime, cancels pending timers, drains callback registrations, and removes all receiver nodes.

```ts
engine.destroy();
```

### useEffect Cleanup Pattern

When using Rill inside a React component, destroy the engine in the cleanup function of a `useEffect`:

```ts
useEffect(() => {
  const engine = new Engine({ /* ... */ });
  engine.load(bundleSource);

  return () => {
    engine.destroy();
  };
}, []);
```

Failing to destroy the engine on unmount will leak the sandbox runtime and all associated memory.

---

## Integration Checklist

Before shipping to production, verify the following:

- A sandbox provider with real isolation is selected for untrusted guests — `node-vm` is not a security boundary; use `wasm-quickjs`, `quickjs`, `jsc`, or `tenant-manager`.
- `requireWhitelist` is explicitly set and contains only the modules the guest needs.
- `timeout` is configured with a value appropriate for the bundle complexity.
- `receiverMaxBatchSize` is tuned if the guest produces large render batches.
- `onMetric` is wired to your telemetry system.
- `logger` is connected to your structured logging pipeline.
- `engine.destroy()` is called on component unmount or when the engine is no longer needed.
- The bundle has passed `rill analyze` with no violations.
- Health checks (`engine.getDiagnostics()` -- the `health` and `resources` fields) are integrated into monitoring dashboards.
- Error handling covers `RequireError`, `ExecutionError`, and `TimeoutError`.
