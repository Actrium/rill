# Guest Runtime Architecture

The guest runtime is the code that executes inside the sandboxed JavaScript engine. It provides React, the SDK, the reconciler, and all supporting infrastructure needed for guest applications to render UI declaratively.

## Two-Phase Architecture

### Build Phase

The build phase compiles the entire guest runtime into a single IIFE string constant (`GUEST_BUNDLE_CODE`) that can be evaluated in any JavaScript sandbox.

**Entry point:** `scripts/build-guest-bundle.ts`
**Input:** `src/guest/bundle.ts`
**Output:** `src/guest/build/bundle.ts` (exported as `GUEST_BUNDLE_CODE`)

The build process:
1. Resolves all imports from `src/guest/runtime/`, `src/sdk/`, `src/shared/`
2. Bundles React (lightweight shim), SDK, Reconciler, and shared protocol into a single module
3. Wraps everything in an IIFE to avoid polluting the global scope
4. Minifies and tree-shakes for size optimization
5. Transpiles to ES5 for maximum sandbox compatibility (QuickJS, JSC, older Hermes)

This pre-bundling approach provides:
- **Startup performance** -- Single eval instead of multiple require/eval calls
- **Version consistency** -- Guest React and reconciler versions are locked together
- **Size optimization** -- Dead code is eliminated at build time

### Runtime Phase

When `Engine.loadBundle` is called, the runtime injection follows a strict sequence.

## Runtime Injection Sequence

The order of injection is critical. Each step depends on globals established by previous steps.

### Step 1: Console Setup

Individual console methods are injected as separate globals (`__console_log`, `__console_warn`, `__console_error`, `__console_debug`, `__console_info`) because JSC sandboxes cannot handle objects with function properties passed through the RN bridge. The guest bundle constructs a proper `console` object from these primitives.

### Step 2: Timer Polyfills

`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, and `queueMicrotask` are injected before the guest bundle because React's scheduler needs `setImmediate` during initialization.

The `setImmediate` implementation uses a synchronous callback queue with explicit drain. This avoids reliance on the host's `queueMicrotask` (which drains too late in XPC ViewBridge contexts where RCTTiming is frozen).

### Step 3: GUEST_BUNDLE_CODE

The pre-built IIFE is evaluated, establishing:
- `React` and `ReactJSXRuntime` / `ReactJSXDevRuntime` globals (lightweight shim)
- `RillGuest` global (component constructors and hooks)
- `RillReconciler` global (reconciler API: `render`, `invokeCallback`, `releaseCallback`, etc.)
- `__rillHooks` state object for useState/useEffect
- `__rill.callbacks` Map for function registration
- `__rill.registerCallback`, `__rill.invokeCallback`, `__rill.dispatchEvent` runtime helpers

### Step 4: require() Module Loader

A whitelisted `require()` function is injected. It supports exactly these modules:
- `react` -- Returns the `React` global from the sandbox
- `react-native` -- Returns a minimal RN shim
- `react/jsx-runtime` and `react/jsx-dev-runtime` -- Returns JSX runtime shim
- `rill/reconciler` -- Returns `RillReconciler` with Engine-bound `render` and `scheduleRender`
- `rill/guest` -- Returns `RillGuest`

Any other module name throws a `RequireError`.

### Step 5: Runtime API Injection

Engine-provided globals:
- `__rill_sendBatch(batch)` -- Routes operation batches through Bridge to Receiver
- `__rill_sendOperation(op)` -- Sends a single operation immediately (used by Remote Ref)
- `__rill_getConfig()` -- Returns initial configuration
- `__rill_emitEvent(eventName, payload)` -- Sends named events to host
- `__rill_handleMessage(message)` -- Dispatches incoming host messages (CALL_FUNCTION, HOST_EVENT, etc.)
- `__rill_schedule_render()` -- Triggers re-render from guest hooks (useState/useEffect)
- `__rill_register_component_type(fn)` -- Registers guest function components for JSI transport
- Component name globals (e.g., `View = 'View'`, `Text = 'Text'`) for registered component types

### Step 6: User Bundle Execution

The developer's guest code is evaluated. Typically it calls `require('rill/reconciler').render(element, __rill_sendBatch)` to kick off the initial render.

After `eval`, the engine explicitly drains the `setImmediate` queue so that React's scheduled reconciliation completes synchronously before `loadBundle` returns.

## Reconciler Implementation

The reconciler is a custom `react-reconciler` host configuration that translates React tree mutations into serializable operations.

### Directory: `src/guest/runtime/reconciler/`

**host-config.ts** -- Implements the `react-reconciler` host config interface:
- `createInstance(type, props)` -- Creates a VNode, encodes props (functions to fnId), emits `CREATE` operation
- `createTextInstance(text)` -- Creates `__TEXT__` VNode, emits `CREATE` + `TEXT`
- `appendChild(parent, child)` -- Emits `APPEND`
- `insertBefore(parent, child, beforeChild)` -- Emits `INSERT`
- `removeChild(parent, child)` -- Emits `REMOVE` + `DELETE`
- `commitUpdate(instance, updatePayload, ...)` -- Emits `UPDATE` with changed props
- `resetAfterCommit()` -- Triggers `OperationCollector.flush()`

**operation-collector.ts** -- Accumulates operations during a render pass and flushes them as a single `OperationBatch` at commit time. Maintains batch ID sequencing.

**element-transform.ts** -- Pre-processes guest elements before they enter the reconciler. Handles:
- Fragment flattening
- Component type bridging (string names to reconciler-recognized types)
- Marker elements for conditional rendering

**guest-encoder.ts** -- Props serialization for the guest side:
- Functions are registered in `CallbackRegistry` and replaced with `{ __type: 'function', __fnId, __name, __sourceFile, __sourceLine }`
- Style objects are passed through
- Nested structures are recursively encoded

**binary-encoder.ts** -- Optional binary encoding support (P3 protocol). Encodes operation batches into `ArrayBuffer` using the binary instruction format for reduced size and faster transfer.

**reconciler-manager.ts** -- Manages reconciler instances. Caches the reconciler container so that subsequent `render` calls reuse the same instance (enabling proper diffing).

**types.ts** -- VNode type definition, reconciler type aliases.

## Guest SDK

### Directory: `src/sdk/`

**sdk.ts** -- Provides the public API for guest developers:
- Component constructors: `View`, `Text`, `ScrollView`, `Image`, `TouchableOpacity`, `TextInput`, `Panel`, etc.
- `useHostEvent(eventName, handler)` -- Subscribe to host events
- `useConfig()` -- Read current configuration
- `sendEventToHost(name, payload)` -- Send events to the host
- `useRef()` -- Create refs that support Remote Ref method calls

**types.ts** -- TypeScript type definitions for all SDK components and hooks.

**index.ts** -- Public export barrel.

## Directory Structure

```
src/guest/
  bundle.ts                     Build entry point
  build/
    bundle.ts                   Pre-built IIFE (GUEST_BUNDLE_CODE)
  runtime/
    init.ts                     Guest initialization tenant manager
    globals-setup.ts            Console and global shim construction
    react-global.ts             Inject React/JSX runtimes (real React)
    reconciler/
      host-config.ts            react-reconciler host configuration
      operation-collector.ts    Operation batching and flush
      element-transform.ts      Element pre-processing
      guest-encoder.ts          Props serialization
      binary-encoder.ts         Binary protocol encoding
      reconciler-manager.ts     Reconciler instance cache
      types.ts                  VNode and reconciler types
      devtools.ts               DevTools integration hooks
      index.ts                  Public reconciler API

src/sdk/
  sdk.ts                        SDK implementation
  types.ts                      Type definitions
  index.ts                      Public exports
```
