# Rill API Reference

Rill is a lightweight, headless, sandboxed dynamic UI rendering engine for React Native. This document provides an overview of the package exports and links to detailed API references.

## Package Export Paths

| Export Path | Description |
|---|---|
| `rill/host` | Host runtime: Engine, useEngineView |
| `rill/host/preset` | Host UI helpers: EngineView, DefaultComponents |
| `rill/guest` | Guest SDK: components, hooks, types for sandbox-side code |
| `rill/devtools` | Development and debugging tools (RuntimeCollector, CDP transport) |
| `rill/cli` | CLI build tools for compiling Guest bundles |

> `import ... from 'rill'` is intentionally unsupported. Use `rill/host` and `rill/guest`.

## Module Overview

### Host Runtime (`rill/host`)

The host runtime is the core of Rill. It manages sandbox lifecycle, component registration, instruction processing, and rendering. The primary API is:

- **Engine** -- Creates and manages an isolated JS sandbox. Loads Guest bundles, handles bidirectional communication, and owns the Bridge, Receiver, and CallbackRegistry.
- **useEngineView** -- A Host hook for rendering an Engine into a React tree.

See [host.md](./host.md) for the full Host API reference.

### Host Preset (`rill/host/preset`)

Opinionated Host UI helpers:

- **EngineView** -- Declarative wrapper for Engine + useEngineView.
- **DefaultComponents** -- Default host component mapping for common React Native primitives.

### Guest (`rill/guest`)

The Guest SDK provides the components, hooks, and platform APIs available inside the sandbox. Guest code uses standard React patterns (JSX, hooks) and communicates with the host through a well-defined protocol.

- **Components** -- View, Text, Image, TouchableOpacity, ScrollView, FlatList, TextInput, Button, Switch, ActivityIndicator.
- **Hooks** -- useConfig, useHostEvent, useSendToHost, useRemoteRef.
- **Platform APIs** -- Platform, Dimensions, StyleSheet, Linking.

See [guest.md](./guest.md) for the full Guest API reference.

### Orchestrator (`rill/host` with `sandbox: 'orchestrator'`)

The Orchestrator is a native C++ multi-tenant sandbox manager exposed to the host JS runtime via JSI. It provides tenant lifecycle management, per-tenant resource quotas, permission enforcement, and a cross-tenant EventBus.

- **Note:** You don't import a provider. `Engine` auto-detects `globalThis.__RillOrchestrator` and delegates internally, or you can force it via `EngineOptions.sandbox = 'orchestrator'`.
- **RillOrchestratorJSI** -- The full JSI interface for tenant management, code loading, communication, metrics, and EventBus operations.

See [orchestrator.md](./orchestrator.md) for the full Orchestrator API reference.

### Sandbox Providers (internal)

Sandbox providers implement the `JSEngineProvider` interface, but they are internal (not exported as `rill/sandbox*`).

Use `EngineOptions.sandbox` to select an engine backend.

| Backend | Platform | Isolation | Notes |
|---|---|---|---|
| `vm` | Node.js / Bun | Process-level | Default for server/test environments |
| `jsc` | Apple (iOS/macOS) | JSI native | JavaScriptCore via JSI |
| `hermes` | React Native | JSI native | Hermes sandbox via JSI |
| `quickjs` | Cross-platform | JSI native | QuickJS via JSI |
| `wasm-quickjs` | Web / React Native | WASM | QuickJS compiled to WebAssembly |
| `orchestrator` | Apple (iOS/macOS) | Native C++ | Multi-tenant with dedicated threads |
| `none` | Any | None | Direct eval in host context (insecure) |

### DevTools (`rill/devtools`)

Development tools for inspecting sandbox state, component trees, console output, and performance metrics. Supports Chrome DevTools Protocol (CDP) transport for remote debugging.

### CLI (`rill/cli`)

Build tools for compiling Guest source code into optimized bundles suitable for sandbox execution. Handles JSX transformation, module resolution, and tree-shaking.
