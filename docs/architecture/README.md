# Rill Architecture Overview

Rill is a lightweight, headless, sandboxed dynamic UI rendering engine for React Native. It executes untrusted guest code in an isolated JavaScript runtime and renders the resulting UI descriptions as native React Native components on the host.

## Design Philosophy

1. **Producer-Consumer Pattern** -- The guest sandbox produces declarative UI descriptions (operation batches), and the host consumes them to render native components. Neither side directly accesses the other's memory.

2. **Whitelist Component Security** -- Only component types that the host has explicitly registered through `ComponentRegistry` can be rendered. Unregistered type names are silently dropped, preventing guest code from instantiating arbitrary native views.

3. **Function Serialization** -- Callbacks cannot cross the sandbox boundary as live references. Every function is assigned a unique `fnId` and replaced with a `{ __type: 'function', __fnId }` descriptor. When the host needs to invoke a guest callback (e.g., `onPress`), it sends a `CALL_FUNCTION` message back into the sandbox.

4. **Batch Update Optimization** -- The reconciler collects all structural and property mutations during a single React commit phase and flushes them as one `OperationBatch`, minimizing boundary crossings.

5. **Sandbox Isolation** -- Guest code runs in a dedicated JavaScript engine instance (JavaScriptCore, QuickJS, Hermes, WASM, or Node `vm`). The host injects a carefully controlled set of globals; no ambient APIs (network, file system, timers) are available unless explicitly polyfilled.

## Four-Layer Architecture

```
Platform Layer  (iOS / macOS / Android / Web)
  |
  +-- C++ TenantManager  (multi-tenant management, thread pool, event bus)
  |     |
  |     +-- Per-Tenant Sandbox  (isolated JS runtime, timer wheel, security)
  |           |
  |           +-- Guest App  (React components via rill/guest)
  |
  +-- Host Shell  (EngineView renders native React Native components)
```

**Platform Layer** -- Native entry point. On Apple platforms this is a TurboModule (`RillSandboxNativeTurboModule`) that installs the C++ tenant manager into the React Native host runtime.

**C++ TenantManager** -- Singleton (`RillTenantManager`) that coordinates tenant creation, thread assignment, resource quotas, event bus, security contexts, and CDP debugging. Installed as `globalThis.__RillTenantManager` via JSI HostObject.

**Per-Tenant Sandbox** -- Each tenant gets a `TenantThread` with its own run loop, `TimerWheel`, and JS runtime. The sandbox executes guest bundles in complete isolation from other tenants and from the host.

**Guest App** -- Developer-authored React components that import from `rill/guest`. These are compiled into a self-contained bundle and evaluated inside the sandbox.

**Host Shell** -- The `Engine` class manages the sandbox lifecycle. Its `Receiver` maintains a `nodeMap` of virtual nodes and renders them as a live React element tree consumed by `EngineView`.

## Module Overview

```
src/
  host/               Host runtime
    engine/              Sandbox engine core (lifecycle, polyfills, runtime API)
      engine.ts
      types.ts           Engine types and public interface
      timer-manager.ts   Timer polyfills & scheduling
      diagnostics-collector.ts  Activity/health tracking
      sandbox-helpers.ts Console + global helpers
      shims.ts           DevTools/runtime shims
    receiver/            Instruction Receiver (nodeMap, render)
      receiver.ts
      types.ts
      stats.ts
    registry.ts          ComponentRegistry (whitelist)
    tenant manager/        TenantManagerProvider (TS adapter for C++ tenant manager)
    preset/              Built-in component presets

  guest/               Guest runtime
    bundle.ts            Entry point compiled into GUEST_BUNDLE_CODE
    build/bundle.ts      Pre-built IIFE string (output of build phase)
    runtime/
      init.ts            Guest initialization sequence
      globals-setup.ts   Console and global shim setup
      react-global.ts    Lightweight React shim for sandbox
      reconciler/        Custom react-reconciler host config
        host-config.ts     createInstance, appendChild, commitUpdate, etc.
        operation-collector.ts   Batches operations, flushes on commit
        element-transform.ts     Transforms guest elements
        guest-encoder.ts         Props serialization (functions -> fnId)
        binary-encoder.ts        Binary encoding (P3 protocol)
        reconciler-manager.ts    Reconciler instance cache
        types.ts                 VNode and reconciler types

  sdk/                 Guest SDK
    sdk.ts               Component constructors and hooks (useHostEvent, useConfig, etc.)
    types.ts             SDK type definitions
    index.ts             Public exports

  shared/              Shared protocol (used by both host and guest)
    types.ts             Operation types, message types, serialized types
    type-rules.ts        21 encoding/decoding rules for cross-boundary values
    callback-registry.ts Reference-counted function registry
    serialization.ts     createEncoder / createDecoder utilities
    bridge/
      bridge.ts          Bidirectional communication coordinator
      promise-manager.ts Cross-boundary promise lifecycle
      binary-protocol.ts TypeScript binary protocol support

  sandbox/             Sandbox provider implementations
  cli/                 Build tooling
  devtools/            Runtime DevTools collector

native/core/src/      C++ TenantManager and supporting modules
    RillTenantManager.h/.mm    Singleton JSI HostObject
    TenantRegistry.h/.cpp     Tenant state tracking
    TenantHandle.h/.cpp       Per-tenant wrapper (runtime, context, state machine)
    TenantThread.h/.cpp       Dedicated execution thread with priority queue
    TenantContext.h/.cpp       Tenant metadata and resource quota
    ThreadPool.h/.cpp          Thread lifecycle management
    TimerWheel.h/.cpp          Native timer scheduling per thread
    EventBus.h/.cpp            Cross-tenant pub/sub
    InstructionFormat.h        Binary wire format definition
    InstructionEncoder.h/.cpp  C++ binary encoder
    InstructionDecoder.h/.cpp  C++ binary decoder
    InstructionCodec.h/.cpp    Codec utilities
    security/
      SecurityManager.h/.cpp   Per-tenant security context factory
      NetworkSandbox.h/.cpp    Domain whitelist, rate limiting, audit
      FileSandbox.h/.cpp       Path sandboxing, quotas
    devtools/
      CDPServer.h/.cpp         Chrome DevTools Protocol server
      CDPTransportApple.h/.mm  Apple Network.framework WebSocket transport
      ConsoleAdapter.h/.cpp    CDP Console domain
      RuntimeAdapter.h/.cpp    CDP Runtime domain
      DOMAdapter.h/.cpp        CDP DOM domain
      DebuggerAdapter.h/.cpp   CDP Debugger domain
      NetworkAdapter.h/.cpp    CDP Network domain
```

## Data Flow Summary

**Rendering (Guest to Host):**

```
Guest JSX
  -> createElement
  -> React Reconciler (custom host-config)
  -> OperationCollector
  -> flush (sendToHost)
  -> Bridge (encoding via TypeRules)
  -> Receiver.applyBatch
  -> nodeMap
  -> render()
  -> React.createElement tree
  -> Native components
```

**Events (Host to Guest):**

```
Host user event (e.g., onPress)
  -> Receiver finds fnId on the prop
  -> Bridge.sendToGuest(CALL_FUNCTION)
  -> Guest __rill.invokeCallback(fnId, encodedArgs)
  -> Guest callback executes
  -> setState / re-render
  -> New operation batch
  -> Host Receiver applies incremental diff
```
