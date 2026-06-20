# Sandbox Engine Comparison

Rill 把 JavaScript 执行抽象在一个内部的 `JSEngineProvider` 接口之后。项目内置了 5 种 provider 实现，对应不同运行时环境。

注意：这些 provider **不是公共 API**，也不支持用户注入自定义 provider。对外只提供 `EngineOptions.sandbox` 用于选择/提示沙箱后端；其余细节由引擎内部自动选择（例如 `DefaultProvider` 与 Orchestrator 集成）。

---

## Comparison Table

| Feature | JSC Native | Hermes Native | QuickJS Native | QuickJS WASM | Node VM |
|---|---|---|---|---|---|
| **Class** | `JSCProvider` | `HermesProvider` | `QuickJSProvider` | `QuickJSNativeWASMProvider` | `VMProvider` |
| **Import** | *(internal)* `src/host/sandbox/providers/JSCProvider*` | *(internal)* `src/host/sandbox/providers/HermesProvider*` | *(internal)* `src/host/sandbox/providers/QuickJSProvider*` | *(internal)* `src/host/sandbox/providers/QuickJSNativeWASMProvider` | *(internal)* `src/host/sandbox/providers/VMProvider` |
| **Platform** | iOS / macOS / tvOS / visionOS | React Native (Hermes runtime) | iOS, Android, macOS, Windows | Web (browser) | Node.js / Bun |
| **Technology** | System JavaScriptCore + JSI | Hermes + JSI | QuickJS + JSI | QuickJS C compiled to WASM (Emscripten) | Node.js `vm` module |
| **Isolation** | Full (separate JSC context) | Full (isolated Hermes runtime) | Full (separate QuickJS context) | Strong (WASM linear-memory boundary) | Strong (Node VM context) |
| **Binary size** | 0 KB (system built-in) | 0 KB (reuses app Hermes engine) | ~200 KB | ~300 KB (gzipped) | 0 KB |
| **Data transfer** | Full JSI (zero-copy objects) | Full JSI (zero-copy objects) | Full JSI (zero-copy objects) | JSON across JS/WASM boundary | Full (shared V8 heap) |
| **Init time (first)** | < 1 ms | < 1 ms | < 5 ms | ~80 ms | < 1 ms |
| **Init time (cached)** | < 1 ms | < 1 ms | < 1 ms | ~10 ms (WASM module cached) | < 1 ms |
| **Call overhead** | < 0.01 ms | < 0.01 ms | < 0.02 ms | ~0.05 ms | < 0.01 ms |
| **Memory (base)** | 0 MB | 0 MB | ~5 MB | ~5 MB | 0 MB |
| **Memory (per instance)** | ~2 MB | ~2 MB | ~3 MB | ~3 MB | ~2 MB |
| **Hard timeout** | No | No | No | No | Yes (`vm.Script` timeout) |
| **Bytecode precompilation** | No | Yes (`evalBytecode`) | No | No | No |
| **`evalAsync`** | No | No | No | Yes | No |
| **Binary transfer** | No | No | No | Optional (`BinaryTransferCapabilities`) | No |
| **Timer support** | Via host injection | Via host injection | Via host injection | Built-in (WASM timer bridge) | Via host injection |

---

## Provider Details

### JSC Native -- `JSCProvider`

Best choice for Apple platforms. JavaScriptCore is shipped as a system framework on iOS, macOS, tvOS, and visionOS, so the provider adds zero binary size. Communication with the host uses JSI, giving zero-copy object transfer for functions, circular references, and complex graphs.

**Source:** `src/host/sandbox/providers/JSCProvider.native.ts`

**Availability check:**

```ts
const isJSCAvailable = typeof (globalThis as any).__JSCSandboxJSI !== 'undefined';
```

**Characteristics:**

- Requires the `RillSandboxNative` native module to be linked.
- Detected at runtime via `globalThis.__JSCSandboxJSI`.
- No hard timeout interrupt; the host must enforce timeouts externally.
- No bytecode precompilation; code is parsed and compiled on every `eval` call.

---

### Hermes Native -- `HermesProvider`

Ideal for React Native apps that already run on the Hermes engine. Like JSC Native, Hermes Native reuses the engine already bundled with the app, adding zero binary overhead.

**Source:** `src/host/sandbox/providers/HermesProvider.native.ts`

**Build requirement:** The native module must be compiled with `RILL_SANDBOX_ENGINE=hermes`.

**Unique feature -- bytecode precompilation:**

```bash
# Compile guest JS to Hermes bytecode
hermesc -emit-binary -O -out guest.hbc guest.js
```

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'hermes' });
// Note: provider-level bytecode APIs are internal.
```

This path eliminates the parse-and-compile cost entirely, making it the fastest way to start guest code when the bundle is known ahead of time.

**Characteristics:**

- Detected at runtime via `globalThis.__HermesSandboxJSI`.
- Full JSI data transfer (functions, circular references, complex objects).
- No hard timeout interrupt.
- `evalBytecode` accepts `ArrayBuffer` in `.hbc` format.

---

### QuickJS Native -- `QuickJSProvider`

Cross-platform solution that works on iOS, Android, macOS, and Windows. QuickJS is compiled as a native library and exposed through JSI bindings. The compiled library adds roughly 200 KB to the app binary.

**Source:** `src/host/sandbox/providers/QuickJSProvider.native.ts`

**Availability check:**

```ts
const isQuickJSAvailable = typeof (globalThis as any).__QuickJSSandboxJSI !== 'undefined';
```

**Characteristics:**

- Good default when platform-specific providers (JSC, Hermes) are unavailable.
- Detected at runtime via `globalThis.__QuickJSSandboxJSI`.
- Full JSI data transfer.
- No hard timeout interrupt.
- No bytecode precompilation.

---

### QuickJS WASM -- `QuickJSNativeWASMProvider`

Web platform solution. The same QuickJS C source is compiled to WebAssembly via Emscripten, producing a `quickjs-sandbox.wasm` binary (~300 KB gzipped). The WASM linear-memory boundary provides strong isolation between host and guest.

**Source:** `src/host/sandbox/providers/QuickJSNativeWASMProvider.ts`

**Build from source:**

```bash
cd rill/native/quickjs
./build-wasm.sh release
# Output: quickjs-sandbox.{js,wasm} -> rill/src/host/sandbox/wasm/
```

**Usage:**

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'wasm-quickjs' });
// Note: WASM asset wiring is internal today.
```

**Characteristics:**

- `createRuntime` is asynchronous (WASM module must be fetched and compiled).
- WASM module is cached after first load; subsequent runtimes reuse it.
- Data crosses the JS/WASM boundary as JSON (not zero-copy).
- Built-in timer bridge (`setTimeout`/`setInterval`) wired through WASM callbacks.
- Supports `evalAsync` for non-blocking evaluation.
- Optional `BinaryTransferCapabilities` for zero-copy `ArrayBuffer` transfer.
- Functions passed via `inject` are proxied through a host callback mechanism.

---

### Node VM -- `VMProvider`

Development and testing provider. Uses the Node.js `vm` module to create isolated V8 contexts. Shares the same V8 heap as the host process, giving near-zero overhead and true hard timeout support.

**Source:** `src/host/sandbox/providers/VMProvider.ts`

**Usage:**

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'vm' });
```

**Characteristics:**

- Hard timeout via `vm.Script.runInContext({ timeout })` -- the only provider with true interrupt capability.
- Shared V8 heap means objects pass by reference with no serialization.
- Available only in Node.js and Bun (requires the `node:vm` built-in module).
- Not suitable for production mobile apps.
- Context cleanup iterates and deletes all global properties to assist garbage collection.

---

## Recommended Provider by Scenario

| Scenario | Provider | Reason |
|---|---|---|
| iOS / macOS / tvOS / visionOS | `JSCProvider` | Zero binary overhead, system JSC, full JSI |
| React Native with Hermes engine | `HermesProvider` | Zero overhead, bytecode precompilation |
| Cross-platform React Native (Android, Windows) | `QuickJSProvider` | Small footprint (~200 KB), full JSI |
| Web browser | `QuickJSNativeWASMProvider` | Only option for web; strong WASM isolation |
| Node.js / Bun (dev, test, CI) | `VMProvider` | Native speed, hard timeout, zero setup |

---

## DefaultProvider Auto-Detection Logic

`new DefaultProvider(options)` selects a provider automatically based on runtime environment detection. Two variants exist:

### Native variant (`default-provider.native.ts`)

Used when the app runs inside React Native. Detection order:

1. **HermesProvider** -- selected when `globalThis.__HermesSandboxJSI` is defined (native module built with `RILL_SANDBOX_ENGINE=hermes`).
2. **JSCProvider** -- selected when `globalThis.__JSCSandboxJSI` is defined (Apple platforms).
3. **QuickJSProvider** -- selected when `globalThis.__QuickJSSandboxJSI` is defined (cross-platform fallback).
4. **Error** -- throws with diagnostic information if no native module is found.

### Non-native variant (`default-provider.ts`)

Used in Node.js, Bun, and web environments. Detection order:

1. **VMProvider** -- selected when `process.versions.node` is defined and `require('node:vm')` resolves.
2. **QuickJSNativeWASMProvider** -- selected when `typeof WebAssembly !== 'undefined'`.
3. **Error** -- throws with environment diagnostic.

### Forcing a specific provider

Pass the `sandbox` option to bypass auto-detection:

```ts
import { Engine } from 'rill/host';

// Force JSC on an Apple platform
const engine = new Engine({ sandbox: 'jsc' });

// Force WASM in a web app
const engine2 = new Engine({ sandbox: 'wasm-quickjs' });
```

The `SandboxType` enum values are internal: `VM`, `JSC`, `Hermes`, `QuickJS`, `WasmQuickJS`.

---

## Core Advantages Across All Providers

Regardless of which provider is selected, every Rill sandbox guarantees the following properties:

- **True isolation.** Guest code cannot access host globals, the filesystem, network, or any capability not explicitly injected through `inject`.
- **Rich data transfer.** All JSI-based providers (JSC, Hermes, QuickJS Native) pass functions, circular references, and complex object graphs directly -- no JSON serialization, no structural cloning, no message ports.
- **Uniform interface.** Every provider implements `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope`. Switching providers requires changing only the constructor; no call-site changes are needed.
- **Deterministic cleanup.** `context.dispose()` and `runtime.dispose()` release all resources. The WASM provider additionally clears pending timers and removes Emscripten function pointers.
- **No degradation or fallback modes.** If a requested provider is unavailable, the system throws immediately rather than silently degrading to a less-capable implementation.

---

## Interface Reference

All providers implement these interfaces (defined in `src/host/sandbox/types/provider.ts`):

```ts
interface JSEngineProvider {
  createRuntime(options?: JSEngineRuntimeOptions): Promise<JSEngineRuntime> | JSEngineRuntime;
}

interface JSEngineRuntime {
  createContext(): SandboxScope;
  dispose(): void;
}

interface SandboxScope {
  eval(code: string): unknown;
  evalAsync?(code: string): Promise<unknown>;       // QuickJS WASM only
  evalBytecode?(bytecode: ArrayBuffer): unknown;     // Hermes only
  inject(name: string, value: unknown): void;
  extract(name: string): unknown;
  dispose(): void;
  binary?: BinaryTransferCapabilities;               // QuickJS WASM only
}

interface JSEngineRuntimeOptions {
  timeout?: number;
  memoryLimit?: number;
  [key: string]: unknown;
}
```

Note that `createRuntime` returns a `Promise` for the WASM provider and a synchronous value for all others.
