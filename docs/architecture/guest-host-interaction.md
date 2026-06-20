# Rendering Pipeline & Communication Protocol

This document describes how the guest sandbox and host runtime communicate, the full rendering pipeline from JSX to native components, and the message protocol that connects them.

## Roles and Boundaries

| Role | Location | Responsibility |
|---|---|---|
| **Host App** | React Native process | Creates `Engine`, registers components via `ComponentRegistry`, mounts `EngineView` |
| **Engine** | `src/host/engine/engine.ts` | Manages sandbox lifecycle, injects globals, owns `Bridge` and `CallbackRegistry` |
| **Bridge** | `src/shared/bridge/bridge.ts` | Bidirectional encoding/decoding, routes operations and messages |
| **Receiver** | `src/host/receiver/receiver.ts` | Applies operation batches, maintains `nodeMap`, produces React element tree |
| **Reconciler** | `src/guest/runtime/reconciler/` | Custom `react-reconciler` host config that converts React tree changes into operations |
| **Guest Runtime** | Sandbox JS engine | Executes guest bundle, manages hooks state, runs callbacks |

The sandbox boundary is the critical trust boundary. All data crossing it passes through `Bridge` and `type-rules.ts` for encoding and sanitization.

## Communication Channels

### Guest to Host: `__rill_sendBatch(batch)`

High-frequency channel. The reconciler batches all mutations from a single React commit phase into an `OperationBatch` and calls `__rill_sendBatch`. Bridge encodes the batch (functions become `{ __type: 'function', __fnId }`, complex types serialized via TypeRules) and delivers it to `Receiver.applyBatch`.

```
Guest Reconciler -> __rill_sendBatch(batch) -> Bridge.sendRawBatch -> onGuestOperations -> Receiver.applyBatch
```

### Host to Guest: `sendToSandbox(message)`

Lower-frequency channel used for callback invocations, host events, configuration updates, and teardown. Parameters are sanitized for JSON safety before crossing the boundary.

```
Engine.sendToSandbox -> Bridge.sendToGuest -> context.inject + evalCode -> Guest __rill_handleMessage
```

## Rendering Pipeline

### 1. JSX to Virtual Nodes

Guest code writes standard React JSX:

```jsx
const App = () => <View style={{ flex: 1 }}><Text>Hello</Text></View>;
```

The pre-bundled React shim provides `createElement`. The custom reconciler host config (`host-config.ts`) implements:

- `createInstance(type, props)` -- Creates a `VNode` with a unique numeric ID, serialized props (functions replaced with fnId markers), and the component type string.
- `createTextInstance(text)` -- Creates a `__TEXT__` VNode.
- `appendChild(parent, child)` -- Records an `APPEND` operation.
- `insertBefore(parent, child, before)` -- Records an `INSERT` operation.
- `removeChild(parent, child)` -- Records `REMOVE` + `DELETE` operations.

### 2. Operation Collection and Flush

During the commit phase, `OperationCollector` accumulates all operations. At the end of the commit (`resetAfterCommit`), the collector flushes the batch:

```typescript
const batch: OperationBatch = {
  version: 1,
  batchId: nextBatchId++,
  operations: [...collected],
};
__rill_sendBatch(batch);
```

### 3. Bridge Encoding

`Bridge.sendRawBatch` encodes the batch using `TypeRules`:

- Functions in props become `{ __type: 'function', __fnId, __name, __sourceFile, __sourceLine }`
- Complex types (Date, RegExp, Map, Set, Error) are serialized to JSON-safe representations
- Circular references become `{ __type: 'circular' }`

The encoded batch is delivered to the `onGuestOperations` callback.

### 4. Receiver Processing

`Receiver.applyBatch` iterates over operations and updates its internal `nodeMap`:

- `CREATE` -- Adds a new `NodeInstance` to `nodeMap`
- `UPDATE` -- Merges new props, releases old function references
- `APPEND` / `INSERT` -- Updates parent-child relationships (with O(1) Set-based lookups)
- `REMOVE` / `DELETE` -- Detaches and recursively cleans up nodes
- `REORDER` -- Replaces children array
- `TEXT` -- Updates text content
- `REF_CALL` -- Dispatches method call to a host component ref

After processing, `scheduleUpdate` triggers a microtask that calls `onUpdate`, which causes `EngineView` to re-render.

### 5. Rendering to Native Components

`Receiver.render()` walks the tree starting from `rootChildren`:

```typescript
renderNode(id) {
  const node = nodeMap.get(id);
  const Component = registry.get(node.type);  // Whitelist lookup
  const children = node.children.map(renderNode);
  return React.createElement(Component, { ...node.props, key, ref }, ...children);
}
```

Props are already decoded by Bridge -- functions are callable proxy closures that route back through `CALL_FUNCTION` messages.

## Update Flow

When guest state changes:

```
Guest setState
  -> React schedules update
  -> Reconciler re-renders (diff against previous VNode tree)
  -> Only changed nodes produce operations (incremental CREATE/UPDATE/REMOVE)
  -> OperationCollector flushes incremental batch
  -> Receiver applies incremental diff to nodeMap
  -> React element tree reflects minimal changes
  -> Native UI updates
```

## Callback Flow

When a host-rendered component fires an event (e.g., `onPress`):

```
1. Native onPress fires
2. Receiver's rendered element has a proxy function (from Bridge decoding)
3. Proxy calls Bridge.invokeFunction(fnId, encodedArgs)
4. Bridge routes to guestInvoker:
   - Looks up __rill.invokeCallback in sandbox context
   - Calls __rill.invokeCallback(fnId, args)
5. Guest CallbackRegistry finds the original function
6. Guest function executes (may call setState)
7. Re-render produces new operations
8. Receiver applies updates
```

Arguments flowing back into the guest are encoded through `TypeRules` to handle complex event objects (e.g., `GestureResponderEvent` with functions like `preventDefault`).

## Operation Types

| Operation | Direction | Fields | Description |
|---|---|---|---|
| `CREATE` | Guest -> Host | `id, type, props` | Create a new virtual node |
| `UPDATE` | Guest -> Host | `id, props, removedProps` | Update node properties |
| `DELETE` | Guest -> Host | `id` | Delete node and all descendants |
| `APPEND` | Guest -> Host | `id, parentId, childId` | Append child to parent |
| `INSERT` | Guest -> Host | `id, parentId, childId, index` | Insert child at position |
| `REMOVE` | Guest -> Host | `id, parentId, childId` | Remove child from parent |
| `REORDER` | Guest -> Host | `id, parentId, childIds` | Reorder children |
| `TEXT` | Guest -> Host | `id, text` | Update text content |
| `REF_CALL` | Guest -> Host | `id, refId, method, args, callId` | Call method on host component ref |

## Host Message Types

| Message | Direction | Fields | Description |
|---|---|---|---|
| `CALL_FUNCTION` | Host -> Guest | `fnId, args` | Invoke a registered guest callback |
| `HOST_EVENT` | Host -> Guest | `eventName, payload` | Deliver a named event to guest listeners |
| `CONFIG_UPDATE` | Host -> Guest | `config` | Update guest configuration |
| `DESTROY` | Host -> Guest | (none) | Signal sandbox teardown |
| `REF_METHOD_RESULT` | Host -> Guest | `refId, callId, result?, error?` | Return value from REF_CALL |
| `PROMISE_RESOLVE` | Host -> Guest | `promiseId, value` | Resolve a cross-boundary promise |
| `PROMISE_REJECT` | Host -> Guest | `promiseId, error` | Reject a cross-boundary promise |
