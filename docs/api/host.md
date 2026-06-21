# Host API Reference

The Host API is the primary interface for embedding Rill in a React Native application. It provides sandbox lifecycle management, component registration, bidirectional communication, and React element tree rendering.

Import path: `rill/host`

Preset UI helpers (declarative rendering + default components) live in: `rill/host/preset`.

---

## Engine

The `Engine` class creates and manages an isolated JS sandbox. Each Engine instance owns a dedicated JS runtime and a host↔guest communication / rendering pipeline.

### Constructor

```typescript
new Engine(options?: EngineOptions)
```

### EngineOptions

| Property | Type | Default | Description |
|---|---|---|---|
| `sandbox` | `'node-vm' \| 'jsc' \| 'quickjs' \| 'hermes' \| 'wasm-quickjs' \| 'tenant-manager'` | Auto-detected | Explicitly select a sandbox backend. |
| `tenant` | `TenantConfig` | `undefined` | Tenant configuration when using the TenantManager sandbox. |
| `timeout` | `number` | `5000` | Execution timeout in milliseconds. |
| `debug` | `boolean` | `false` | Enable debug logging. |
| `logger` | `{ log, warn, error }` | `console` | Custom logger implementation. |
| `requireWhitelist` | `readonly string[]` | `['react', 'react-native', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'rill/guest', 'rill/reconciler']` | Allowed module names for sandbox `require()`. Supports simple trailing `*` prefix patterns (e.g. `rill/*`). |
| `onMetric` | `(name: string, value: number, extra?: Record<string, unknown>) => void` | `undefined` | Performance metrics reporter callback. |
| `receiverMaxBatchSize` | `number` | `5000` | Maximum operations per batch applied by Receiver. Excess operations are skipped to protect host performance. |
| `diagnostics` | `{ activityWindowMs?, activityHistoryMs?, activityBucketMs? }` | See below | Diagnostics parameters for host-side monitoring. |
| `devtools` | `boolean \| RuntimeCollectorConfig` | `undefined` | Enable DevTools integration. Pass `true` for defaults or an object for custom configuration. |

**Diagnostics defaults:**

| Property | Default | Description |
|---|---|---|
| `activityWindowMs` | `5000` | Stats window for calculating ops/s and batch/s. |
| `activityHistoryMs` | `60000` | Activity sample retention duration for timeline aggregation. |
| `activityBucketMs` | `2000` | Timeline bucket width. |

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | `readonly string` | Unique engine identifier (format: `engine-{counter}-{timestamp}-{random}`). |
| `isLoaded` | `boolean` | Whether a Guest bundle has been successfully loaded. |
| `isDestroyed` | `boolean` | Whether the engine has been destroyed. |
| `isPaused` | `boolean` | Whether the engine is currently paused. |

### Methods

#### register(components)

Register host-side component implementations.

```typescript
engine.register(components: ComponentMap): void
```

- `components` -- An object mapping component names (strings) to React component implementations.

#### loadBundle(source, initialProps?)

Load and execute a Guest bundle in the sandbox.

```typescript
engine.loadBundle(source: string, initialProps?: Record<string, unknown>): void | Promise<void>
```

- `source` -- Bundle source code as a string, or a URL (`http://` / `https://`) to fetch the bundle from.
- `initialProps` -- Initial configuration passed to the Guest via `useConfig()`.
- Returns `void` for synchronous providers (JSC) with inline code, or `Promise<void>` for async providers or remote URLs.
- Throws if the engine is already loaded or destroyed.

#### sendEvent(name, payload?)

Send an event to the sandbox Guest. If the engine is paused, events are queued and delivered upon resume.

```typescript
engine.sendEvent(eventName: string, payload?: unknown): void
```

#### updateConfig(config)

Update the Guest configuration. Triggers a `CONFIG_UPDATE` message to the sandbox.

```typescript
engine.updateConfig(config: BridgeValueObject): void
```

- The default Guest runtime forwards this message as a `CONFIG_UPDATE` Host event (so Guest code can subscribe via `useHostEvent('CONFIG_UPDATE', ...)`).
- If the Guest has rendered at least once, the runtime also triggers a re-render so `useConfig()` reads the latest values.

#### on(event, handler)

Subscribe to engine events. Returns an unsubscribe function.

```typescript
engine.on<K extends keyof EngineEvents>(
  event: K,
  listener: (data: ...) => void
): () => void
```

#### pause()

Pause the engine. Freezes all timers and queues incoming events.

```typescript
engine.pause(): void
```

#### resume()

Resume the engine. Unfreezes timers (continuing from remaining time) and flushes queued events.

```typescript
engine.resume(): void
```

#### destroy()

Destroy the engine and release all resources. Emits the `destroy` event, clears timers, disposes the sandbox runtime, and cleans up all internal state.

```typescript
engine.destroy(): void
```

#### Observability (optional)

For monitoring and debugging:

```typescript
engine.getHealth(): EngineHealth;
engine.getResourceStats(): { timers: number; nodes: number; callbacks: number };
engine.getDiagnostics(): EngineDiagnostics;
```

### Events

Subscribe to events using `engine.on(event, handler)`.

| Event | Payload | Description |
|---|---|---|
| `load` | (none) | Guest bundle loaded and executed successfully. |
| `error` | `Error` | A non-fatal error occurred in the sandbox. |
| `fatalError` | `Error` | An unrecoverable error (e.g., timeout). The engine is automatically destroyed. |
| `destroy` | (none) | The engine has been destroyed. |
| `message` | `GuestMessage` | A custom message was sent from the Guest via `useSendToHost()`. |
| `pause` | (none) | The engine has been paused. |
| `resume` | (none) | The engine has been resumed. |
| `devtoolsConsole` | `DevToolsConsoleEntry` | A console log from the Guest sandbox (requires DevTools enabled). |
| `devtoolsError` | `DevToolsError` | An error from the Guest sandbox (requires DevTools enabled). |
| `devtoolsReady` | `Record<string, unknown>` | Guest DevTools is ready. |

Other events exist for advanced integrations (for example, low-level operation batches). Prefer `EngineView` / `useEngineView` unless you are building custom tooling.

---

## EngineView

**Import path:** `rill/host/preset`

A React Native component that provides a declarative interface for Engine lifecycle management and rendering.

### Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `engine` | `Engine` | Yes | The Engine instance to use. |
| `source` | `string` | Yes | Bundle source code or URL. |
| `initialProps` | `Record<string, unknown>` | No | Initial configuration for the Guest. |
| `onLoad` | `() => void` | No | Called when the bundle loads successfully. |
| `onError` | `(error: Error) => void` | No | Called when an error occurs. |
| `onDestroy` | `() => void` | No | Called when the engine is destroyed. |
| `fallback` | `ReactElement` | No | Rendered while the bundle is loading. |
| `renderError` | `(error: Error) => ReactElement` | No | Custom error rendering function. |
| `style` | `ViewStyle` | No | Style applied to the container view. |

---

## useEngineView (Optional)

Import path: `rill/host`

Hook used by custom `EngineView` implementations.

## Internal APIs (Not Exported)

The following concepts exist in the implementation, but are **not** part of the public package API and may change without notice:

- `Receiver` (operation-to-element-tree builder)
- `ComponentRegistry` (component name whitelist / mapping)
- `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope` (provider layer)
- Bridge protocol types such as `OperationBatch` / `HostMessage`
- Specialized error classes such as `RequireError` / `ExecutionError` / `TimeoutError`
