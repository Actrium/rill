# Sandbox Engine Selection & Configuration

Rill supports multiple sandbox backends to run guest bundles in isolation. Each backend targets a specific platform and offers different trade-offs in isolation strength, binary size overhead, and runtime performance.

Note: provider implementations are **internal** (not exported, not user-injectable). The only supported public switch is `EngineOptions.sandbox`.

---

## Provider Overview

| Provider | Platform | Isolation | Size Overhead | Performance |
|---|---|---|---|---|
| JSC Native | iOS / macOS | Full | 0 KB | Excellent |
| Hermes Native | React Native (Hermes) | Full | 0 KB | Excellent |
| QuickJS Native | All React Native platforms | Full | ~200 KB | Very Good |
| QuickJS WASM | Web | Strong | ~300 KB | Very Good |
| Node VM | Node / Bun | Strong | 0 KB | Excellent |

---

## JSC Native

Uses the platform JavaScriptCore engine available on Apple platforms. No additional binary is bundled because JSC ships with iOS and macOS.

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'jsc',
  // ...
});
```

**Characteristics:**

- Full process-level isolation via a dedicated `JSGlobalContextRef`.
- Zero additional binary size -- relies on the system JSC framework.
- Best choice on Apple platforms when Hermes is not the active runtime.

---

## Hermes Native

Uses the Hermes engine that ships with React Native. When the host app already runs on Hermes, this provider reuses the same engine binary and avoids any extra weight.

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'hermes',
  // ...
});
```

**Characteristics:**

- Full isolation via a separate Hermes runtime instance.
- Zero additional binary size when the host app uses Hermes.
- Supports **bytecode precompilation** (internal). Public API currently selects the backend via `EngineOptions.sandbox`; provider-level bytecode hooks are not exposed.

---

## QuickJS Native

A lightweight, embeddable JavaScript engine compiled as a native library. Works on all React Native platforms regardless of which JS engine the host app uses.

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'quickjs',
  // ...
});
```

**Characteristics:**

- Full isolation in a dedicated QuickJS runtime context.
- Adds approximately 200 KB to the binary.
- Good fallback when neither JSC nor Hermes providers are suitable.

---

## QuickJS WASM

A WebAssembly build of QuickJS for browser and web-worker environments.

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'wasm-quickjs',
  // ...
});
```

**Characteristics:**

- Strong isolation via the WebAssembly sandbox boundary.
- Approximately 300 KB WASM binary (gzips well).
- This backend is primarily used for internal testing today; configuration options may change.

---

## Node VM

Uses the built-in `node:vm` module. Available in Node.js and Bun environments -- primarily for server-side rendering, testing, and development.

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'node-vm',
  // ...
});
```

**Characteristics:**

- Strong isolation through `vm.createContext` with a frozen global.
- Zero additional binary size.
- Not suitable for production mobile deployments; intended for server, test, and development use.

---

## DefaultProvider Auto-Selection

When no explicit `sandbox` option is provided, Rill selects the best available provider automatically using the following priority:

| Condition | Selected Provider |
|---|---|
| React Native with Hermes (`RILL_SANDBOX_ENGINE=hermes`) | `HermesProvider` |
| Apple platform (iOS / macOS) | `JSCProvider` |
| Any other React Native platform | `QuickJSProvider` |
| Node.js or Bun runtime | `NodeVMProvider` |
| Web browser | `QuickJSNativeWASMProvider` |

The auto-selection runs once at engine creation time. You can override it by passing the `sandbox` option explicitly.

---

## Configuration

The `sandbox` field in `EngineOptions` accepts the following string values:

| Value | Provider |
|---|---|
| `'jsc'` | JSC Native |
| `'hermes'` | Hermes Native |
| `'quickjs'` | QuickJS Native |
| `'wasm-quickjs'` | QuickJS WASM |
| `'node-vm'` | Node VM |
| `'tenant-manager'` | Native TenantManager (multi-tenant mode) |

```ts
const engine = new Engine({
  sandbox: 'quickjs',
  // other options...
});
```

---

## Performance Comparison

### Initialization Time

| Provider | Cold Start | Warm Start |
|---|---|---|
| JSC Native | ~2 ms | < 1 ms |
| Hermes Native | ~2 ms | < 1 ms |
| Hermes (bytecode) | < 1 ms | < 1 ms |
| QuickJS Native | ~5 ms | ~2 ms |
| QuickJS WASM | ~15 ms | ~5 ms |
| Node VM | ~1 ms | < 1 ms |

### Function Call Overhead (host-to-sandbox round-trip)

| Provider | Latency |
|---|---|
| JSC Native | ~0.01 ms |
| Hermes Native | ~0.01 ms |
| QuickJS Native | ~0.02 ms |
| QuickJS WASM | ~0.05 ms |
| Node VM | ~0.01 ms |

### Memory Baseline (empty sandbox context)

| Provider | Baseline |
|---|---|
| JSC Native | ~1.5 MB |
| Hermes Native | ~1.2 MB |
| QuickJS Native | ~0.5 MB |
| QuickJS WASM | ~0.8 MB |
| Node VM | ~2.0 MB |
