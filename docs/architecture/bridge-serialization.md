# Bridge & Serialization

The Bridge layer handles all data encoding, decoding, and routing between the guest sandbox and the host runtime. It is the single point through which all cross-boundary communication flows.

## Directory: `src/shared/`

| File | Purpose |
|---|---|
| `types.ts` | Protocol type system (JSISafe, BridgeValue, Operation, HostMessage, etc.) |
| `type-rules.ts` | 14 ordered encoding/decoding rules |
| `callback-registry.ts` | Reference-counted function ID registry |
| `serialization.ts` | `createEncoder` / `createDecoder` factory functions |
| `bridge/bridge.ts` | Bidirectional communication coordinator |
| `bridge/promise-manager.ts` | Cross-boundary promise lifecycle |
| `bridge/binary-protocol.ts` | TypeScript-side binary protocol support |

## TypeRules: Recursive Encoding

`DEFAULT_TYPE_RULES` is an ordered array of 14 rules. The encoder walks the array top-to-bottom and applies the first matching rule. Each rule specifies a `match` predicate, optional `encode`/`decode` transforms, and a transport strategy (`passthrough`, `serialize`, or `proxy`).

### Rule Order

| # | Rule Name | Match | Encode | Decode | Strategy |
|---|---|---|---|---|---|
| 1 | `null-undefined` | `v === null \|\| v === undefined` | passthrough | passthrough | passthrough |
| 2 | `primitives` | `boolean \| number \| string` | passthrough | passthrough | passthrough |
| 3 | `circular` | `{ __type: 'circular' }` | -- | returns `undefined` | serialize |
| 4 | `serialized-function` | `{ __type: 'function', __fnId }` | -- | creates callable proxy | proxy |
| 5 | `function` | `typeof v === 'function'` | registers in CallbackRegistry, returns `{ __type, __fnId, __name, __sourceFile, __sourceLine }` | -- | proxy |
| 6 | `serialized-promise` | `{ __type: 'promise', __promiseId }` | -- | creates pending Promise via `createPendingPromise` | proxy |
| 7 | `promise` | `v instanceof Promise` | registers via `registerPromise`, returns `{ __type: 'promise', __promiseId }` | -- | proxy |
| 8 | `date` | `v instanceof Date` or `{ __type: 'date' }` | `{ __type: 'date', __value: isoString }` | `new Date(__value)` | serialize |
| 9 | `regexp` | `v instanceof RegExp` or `{ __type: 'regexp' }` | `{ __type: 'regexp', __source, __flags }` | `new RegExp(__source, __flags)` | serialize |
| 10 | `error` | `v instanceof Error` or `{ __type: 'error' }` | `{ __type: 'error', __name, __message, __stack }` | `new Error(__message)` with name and stack | serialize |
| 11 | `map` | `v instanceof Map` or `{ __type: 'map' }` | `{ __type: 'map', __entries: [[k,v]...] }` (recursive) | `new Map(decoded entries)` | serialize |
| 12 | `set` | `v instanceof Set` or `{ __type: 'set' }` | `{ __type: 'set', __values: [...] }` (recursive) | `new Set(decoded values)` | serialize |
| 13 | `typedarray` | `ArrayBuffer.isView(v) && !(DataView)` or `{ __type: 'typedarray' }` | `{ __type: 'typedarray', __ctor, __data, __bigint? }` | reconstructs with named constructor | serialize |
| 14 | `arraybuffer` | `v instanceof ArrayBuffer` or `{ __type: 'arraybuffer' }` | `{ __type: 'arraybuffer', __data: [...bytes] }` | `new Uint8Array(__data).buffer` | serialize |
| 15 | `array` | `Array.isArray(v)` | recursive map | reference-preserving decode | serialize |
| 16 | `toJSON` | object with `toJSON()` method (not Date/RegExp/Error/Map/Set) | calls `toJSON()` then recursive encode | -- | serialize |
| 17 | `object` | `typeof v === 'object' && v !== null` | recursive encode of entries | reference-preserving decode | serialize |

**Reference-preserving decode:** For arrays and plain objects, decoding only creates a new reference if at least one child value changed. This is critical for React reconciliation -- unchanged style objects keep the same reference, avoiding unnecessary re-renders.

**Circular reference handling:** The encoder (via `createEncoder`) tracks visited objects with a `WeakSet`. When a cycle is detected, it emits `{ __type: 'circular' }` instead of recursing infinitely. The decoder converts this back to `undefined`.

## CallbackRegistry

`CallbackRegistry` manages the mapping between live JavaScript functions and their string identifiers (`fnId`).

### fnId Format

```
fn_<instanceId>_<counter>
```

- `instanceId` -- 5-character random base-36 string, unique per `CallbackRegistry` instance
- `counter` -- Auto-incrementing integer

Example: `fn_a3x9k_42`

### Reference Counting

Each registered function starts with a reference count of 1. The host can:
- `retain(fnId)` -- Increment the count (e.g., when a prop is duplicated)
- `release(fnId)` -- Decrement the count; when it reaches 0, the function is removed from the map

This prevents memory leaks from stale callbacks. When the Receiver processes a `DELETE` operation, it releases all `fnId`s associated with the deleted node.

### Guest Environment Sharing

In the guest sandbox, `CallbackRegistry` detects `globalThis.__RILL_GUEST_ENV__ === true` and shares the `globalThis.__rill.callbacks` Map directly. This ensures that functions registered by the reconciler are accessible by `__rill.invokeCallback` without cross-module coordination issues.

A global singleton (`globalCallbackRegistry`) is exported and installed on `globalThis.__rillGlobalCallbackRegistry` to ensure a single instance across all bundled modules.

### Methods

| Method | Description |
|---|---|
| `register(fn)` | Register a function, returns `fnId` |
| `retain(fnId)` | Increment reference count |
| `release(fnId)` | Decrement reference count, remove at zero |
| `invoke(fnId, args)` | Look up and call the function |
| `has(fnId)` | Check if fnId is registered |
| `clear()` | Remove all registrations |
| `getMap()` | Access internal Map (for `globalThis.__rill.callbacks` sync) |
| `size` | Number of registered functions |

## bridge.ts: Bidirectional Communication

`Bridge` coordinates all cross-boundary communication. It is instantiated once per `Engine` and wired to both the guest sandbox and the host Receiver.

### Configuration

```typescript
new Bridge({
  callbackRegistry,     // Engine's CallbackRegistry instance
  guestInvoker,         // (fnId, args) => invoke callback in sandbox
  guestReleaseCallback, // (fnId) => release callback in sandbox
  onGuestOperations,         // (batch: OperationBatch) => apply to Receiver
  onHostMessage,        // (message: HostMessage) => deliver to sandbox
  debug, logger,
});
```

### Guest to Host Flow

```
Guest __rill_sendBatch(batch)
  -> Bridge.sendRawBatch(batch)
  -> Decode serialized props via TypeRules (functions become callable proxies)
  -> Extract fnIds for Receiver tracking (_fnIds annotation)
  -> onGuestOperations(decodedBatch)
  -> Receiver.applyBatch
```

### Host to Guest Flow

```
Engine.sendToSandbox(message)
  -> Bridge.sendToGuest(message)
  -> Encode args via TypeRules (functions become { __type: 'function', __fnId })
  -> onHostMessage(encodedMessage)
  -> context.inject + evalCode
  -> Guest __rill_handleMessage
```

### Transport Modes

Bridge supports three encoding modes for operation batches:
1. **JSON mode** -- Default. Operations serialized as JSON-safe objects via TypeRules.
2. **Serialized object mode** -- Operations already pre-serialized by the guest encoder.
3. **Binary mode** -- Operations encoded as `ArrayBuffer` using the binary instruction protocol (P3).

## PromiseManager

Manages the lifecycle of promises that span the sandbox boundary.

When a guest function returns a `Promise`, it is registered with a `promiseId`. When the promise settles, a `PROMISE_RESOLVE` or `PROMISE_REJECT` message is sent to the other side, where a pending promise (created by `createPendingPromise`) is resolved or rejected.

The manager auto-cleans timed-out promises and is fully cleared on `Bridge.destroy()` to prevent dangling handlers.

## Remote Ref Protocol

Guest code can call methods on host component instances (e.g., `ref.current.focus()`):

1. Guest sends a `REF_CALL` operation: `{ op: 'REF_CALL', refId, method, args, callId }`
2. Receiver finds the React ref for `refId` in its `refMap`
3. Receiver calls the method on the ref's `current` value
4. Result is sent back as a `REF_METHOD_RESULT` message: `{ type: 'REF_METHOD_RESULT', refId, callId, result?, error? }`
5. Guest resolves or rejects the promise associated with `callId`

The `callId` is a unique string that correlates the request with its response, enabling multiple concurrent ref calls.
