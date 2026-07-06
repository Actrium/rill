# Sandbox 引擎对比

Rill 把 JavaScript 执行抽象在一个内部的 `JSEngineProvider` 接口之后。项目内置了 5 种 provider 实现，对应不同运行时环境。

注意：这些 provider **不是公共 API**，也不支持用户注入自定义 provider。对外只提供 `EngineOptions.sandbox` 用于选择/提示沙箱后端；其余细节由引擎内部自动选择（例如 `DefaultProvider` 与 TenantManager 集成）。

---

## 对比表

| 特性 | JSC Native | Hermes Native | QuickJS Native | QuickJS WASM | Node VM |
|---|---|---|---|---|---|
| **Class** | `JSCProvider` | `HermesProvider` | `QuickJSProvider` | `QuickJSNativeWASMProvider` | `NodeVMProvider` |
| **Import** | *(内部)* `src/host/sandbox/providers/JSCProvider*` | *(内部)* `src/host/sandbox/providers/HermesProvider*` | *(内部)* `src/host/sandbox/providers/QuickJSProvider*` | *(内部)* `src/host/sandbox/providers/QuickJSNativeWASMProvider` | *(内部)* `src/host/sandbox/providers/NodeVMProvider` |
| **平台** | iOS / macOS / tvOS / visionOS | React Native (Hermes runtime) | iOS, Android, macOS, Windows | Web (browser) | Node.js / Bun |
| **技术** | System JavaScriptCore + JSI | Hermes + JSI | QuickJS + JSI | QuickJS C compiled to WASM (Emscripten) | Node.js `vm` module |
| **隔离性** | Full (separate JSC context) | Full (isolated Hermes runtime) | Full (separate QuickJS context) | Strong (WASM linear-memory boundary) | Strong (Node VM context) |
| **二进制体积** | 0 KB (system built-in) | 0 KB (reuses app Hermes engine) | ~200 KB | ~300 KB (gzipped) | 0 KB |
| **数据传输** | Full JSI (zero-copy objects) | Full JSI (zero-copy objects) | Full JSI (zero-copy objects) | JSON across JS/WASM boundary | Full (shared V8 heap) |
| **初始化时间（首次）** | < 1 ms | < 1 ms | < 5 ms | ~80 ms | < 1 ms |
| **初始化时间（缓存）** | < 1 ms | < 1 ms | < 1 ms | ~10 ms (WASM module cached) | < 1 ms |
| **调用开销** | < 0.01 ms | < 0.01 ms | < 0.02 ms | ~0.05 ms | < 0.01 ms |
| **内存（基础）** | 0 MB | 0 MB | ~5 MB | ~5 MB | 0 MB |
| **内存（每实例）** | ~2 MB | ~2 MB | ~3 MB | ~3 MB | ~2 MB |
| **硬超时** | No (无公开中断 API) | Yes (`watchTimeLimit`) | Yes (中断 handler) | No | Yes (`vm.Script` timeout) |
| **堆配额 (`maxHeapBytes`)** | No | No | Yes (`JS_SetMemoryLimit`) | No | No |
| **字节码预编译** | No | Yes (`evalBytecode`) | No | No | No |
| **`evalAsync`** | No | No | No | Yes | No |
| **二进制传输** | No | No | No | Optional (`BinaryTransferCapabilities`) | No |
| **Timer 支持** | Via host injection | Via host injection | Via host injection | Built-in (WASM timer bridge) | Via host injection |

---

## Provider 详情

### JSC Native -- `JSCProvider`

Apple 平台的最佳选择。JavaScriptCore 作为系统框架在 iOS、macOS、tvOS 和 visionOS 上提供，因此该 provider 的二进制体积为零。与宿主的通信使用 JSI，为函数、循环引用和复杂对象图提供零拷贝对象传输。

**源文件:** `src/host/sandbox/providers/JSCProvider.native.ts`

**可用性检查:**

```ts
const isJSCAvailable = typeof (globalThis as any).__JSCSandboxJSI !== 'undefined';
```

**特性:**

- 需要链接 `RillSandboxNative` 原生模块。
- 在运行时通过 `globalThis.__JSCSandboxJSI` 检测。
- 没有硬超时中断：JavaScriptCore 唯一的执行时限 API
  (`JSContextGroupSetExecutionTimeLimit`) 是私有头文件，因此未使用。
  租户死循环会阻塞宿主线程；不要依赖此引擎做 CPU 隔离。
- 无堆配额 API；`maxHeapBytes` 被忽略。
- 没有字节码预编译；代码在每次 `eval` 调用时解析和编译。

---

### Hermes Native -- `HermesProvider`

已经运行在 Hermes 引擎上的 React Native 应用的理想选择。与 JSC Native 类似，Hermes Native 复用应用已经打包的引擎，增加零二进制开销。

**源文件:** `src/host/sandbox/providers/HermesProvider.native.ts`

**构建要求:** 原生模块必须使用 `RILL_SANDBOX_ENGINE=hermes` 编译。

**独特功能 -- 字节码预编译:**

```bash
# Compile guest JS to Hermes bytecode
hermesc -emit-binary -O -out guest.hbc guest.js
```

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'hermes' });
// 注意：provider 级别的字节码 API 目前属于内部实现。
```

这种方式完全消除了解析和编译成本，使其成为在提前知道 bundle 的情况下启动 guest 代码的最快方式。

**特性:**

- 在运行时通过 `globalThis.__HermesSandboxJSI` 检测。
- 完整的 JSI 数据传输（函数、循环引用、复杂对象）。
- 通过 `HermesRuntime::watchTimeLimit` 强制硬超时：预算耗尽时正在执行的
  eval 会抛错，而不是挂死宿主线程。
- 无堆配额 API；`maxHeapBytes` 被忽略。
- `evalBytecode` 接受 `.hbc` 格式的 `ArrayBuffer`。

---

### QuickJS Native -- `QuickJSProvider`

跨平台解决方案，适用于 iOS、Android、macOS 和 Windows。QuickJS 被编译为原生库并通过 JSI 绑定暴露。编译后的库为应用二进制增加约 200 KB。

**源文件:** `src/host/sandbox/providers/QuickJSProvider.native.ts`

**可用性检查:**

```ts
const isQuickJSAvailable = typeof (globalThis as any).__QuickJSSandboxJSI !== 'undefined';
```

**特性:**

- 当平台特定的 provider（JSC、Hermes）不可用时的良好默认选择。
- 在运行时通过 `globalThis.__QuickJSSandboxJSI` 检测。
- 完整的 JSI 数据传输。
- 通过 QuickJS 中断 handler 强制硬超时（wall-clock deadline）；租户死循环
  会被中止并抛出超时错误。
- 通过 `JS_SetMemoryLimit` 强制堆配额（`maxHeapBytes`；默认 256MB）。
- 没有字节码预编译。

---

### QuickJS WASM -- `QuickJSNativeWASMProvider`

Web 平台解决方案。相同的 QuickJS C 源代码通过 Emscripten 编译为 WebAssembly，生成 `quickjs-sandbox.wasm` 二进制文件（约 300 KB gzipped）。WASM 线性内存边界在宿主和 guest 之间提供强隔离。

**源文件:** `src/host/sandbox/providers/QuickJSNativeWASMProvider.ts`

**从源代码构建:**

```bash
cd rill/native/quickjs
./build-wasm.sh release
# Output: quickjs-sandbox.{js,wasm} -> rill/src/host/sandbox/wasm/
```

**用法:**

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'wasm-quickjs' });
// 注意：WASM 资源（`quickjs-sandbox.js/.wasm`）的接入目前仍是内部细节。
```

**特性:**

- `createRuntime` 是异步的（必须获取和编译 WASM 模块）。
- WASM 模块在首次加载后被缓存；后续的 runtime 会复用它。
- 数据以 JSON 形式跨越 JS/WASM 边界（非零拷贝）。
- 内置 timer bridge（`setTimeout`/`setInterval`）通过 WASM 回调连接。
- 支持 `evalAsync` 进行非阻塞评估。
- 可选的 `BinaryTransferCapabilities` 用于零拷贝 `ArrayBuffer` 传输。
- 通过 `inject` 传递的函数通过宿主回调机制代理。

---

### Node VM -- `NodeVMProvider`

开发和测试 provider。使用 Node.js `vm` 模块创建隔离的 V8 上下文。与宿主进程共享相同的 V8 堆，提供接近零的开销和真正的硬超时支持。

**源文件:** `src/host/sandbox/providers/NodeVMProvider.ts`

**用法:**

```ts
import { Engine } from 'rill/host';

const engine = new Engine({ sandbox: 'node-vm' });
```

**特性:**

- 通过 `vm.Script.runInContext({ timeout })` 实现硬超时 -- 唯一具有真正中断能力的 provider。
- 共享 V8 堆意味着对象通过引用传递，无需序列化。
- 仅在 Node.js 和 Bun 中可用（需要 `node:vm` 内置模块）。
- 不适合生产环境的移动应用。
- 上下文清理会迭代并删除所有全局属性以协助垃圾回收。

---

## 按场景推荐的 Provider

| 场景 | Provider | 原因 |
|---|---|---|
| iOS / macOS / tvOS / visionOS | `JSCProvider` | 零二进制开销，系统 JSC，完整 JSI |
| React Native with Hermes engine | `HermesProvider` | 零开销，字节码预编译 |
| Cross-platform React Native (Android, Windows) | `QuickJSProvider` | 小体积（约 200 KB），完整 JSI |
| Web browser | `QuickJSNativeWASMProvider` | Web 的唯一选项；强 WASM 隔离 |
| Node.js / Bun (dev, test, CI) | `NodeVMProvider` | 原生速度，硬超时，零配置 |

---

## DefaultProvider 自动检测逻辑

`new DefaultProvider(options)` 基于运行时环境检测自动选择 provider。存在两个变体：

### Native 变体 (`default-provider.native.ts`)

在应用运行于 React Native 内部时使用。检测顺序：

1. **HermesProvider** -- 当 `globalThis.__HermesSandboxJSI` 被定义时选择（原生模块使用 `RILL_SANDBOX_ENGINE=hermes` 构建）。
2. **JSCProvider** -- 当 `globalThis.__JSCSandboxJSI` 被定义时选择（Apple 平台）。
3. **QuickJSProvider** -- 当 `globalThis.__QuickJSSandboxJSI` 被定义时选择（跨平台回退）。
4. **Error** -- 如果没有找到原生模块，则抛出带有诊断信息的错误。

### Non-native 变体 (`default-provider.ts`)

在 Node.js、Bun 和 Web 环境中使用。检测顺序：

1. **NodeVMProvider** -- 当 `process.versions.node` 被定义且 `require('node:vm')` 可解析时选择。
2. **QuickJSNativeWASMProvider** -- 当 `typeof WebAssembly !== 'undefined'` 时选择。
3. **Error** -- 抛出带有环境诊断的错误。

### 强制使用特定 provider

传递 `sandbox` 选项以绕过自动检测：

```ts
import { Engine } from 'rill/host';

// 强制在 Apple 平台使用 JSC
const engine = new Engine({ sandbox: 'jsc' });

// 强制在 Web 中使用 WASM QuickJS
const engine2 = new Engine({ sandbox: 'wasm-quickjs' });
```

`SandboxType` 枚举值为内部实现：`VM`、`JSC`、`Hermes`、`QuickJS`、`WasmQuickJS`。

---

## 所有 Provider 的核心优势

无论选择哪个 provider，每个 Rill sandbox 都保证以下属性：

- **真正的隔离。** Guest 代码无法访问宿主全局变量、文件系统、网络或任何未通过 `inject` 显式注入的能力。
- **丰富的数据传输。** 所有基于 JSI 的 provider（JSC、Hermes、QuickJS Native）直接传递函数、循环引用和复杂对象图 -- 无 JSON 序列化、无结构克隆、无消息端口。
- **统一接口。** 每个 provider 都实现了 `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope`。切换 provider 只需更改构造函数；不需要更改调用点。
- **确定性清理。** `context.dispose()` 和 `runtime.dispose()` 释放所有资源。WASM provider 还会清除待处理的 timer 并移除 Emscripten 函数指针。
- **没有降级或回退模式。** 如果请求的 provider 不可用，系统会立即抛出异常，而不是静默降级到功能较弱的实现。

---

## 接口参考

所有 provider 都实现了这些接口（定义在 `src/host/sandbox/types/provider.ts` 中）：

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

注意 `createRuntime` 对 WASM provider 返回 `Promise`，对所有其他 provider 返回同步值。

> **强制执行现状:** `timeout` 由 QuickJS（原生中断 handler + wall-clock deadline）、Hermes（JSI 变体,经 `HermesRuntime::watchTimeLimit`）与 Node VM（`vm.Script`）强制执行。JSC **不强制**:JavaScriptCore 唯一的执行时限 API 是私有头文件,租户死循环在 JSC 下会阻塞宿主线程 —— 不要依赖 JSC 做 CPU 隔离。堆配额（`maxHeapBytes`,旧选项名 `memoryLimit` 为其别名）由 QuickJS 经 `JS_SetMemoryLimit` 强制执行（未设置时默认 256 MB）,并通过 tenant-manager 路径下发;Hermes 与 JSC 无堆上限 API,忽略该配额。
