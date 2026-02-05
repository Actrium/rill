# 沙箱引擎选择与配置

Rill 支持多种沙箱后端来隔离运行 guest bundle。每个后端针对特定平台，并在隔离强度、二进制大小开销和运行时性能之间提供不同的权衡。

注意：provider 实现属于**内部实现**（不对外导出，也不支持用户注入自定义 provider）。公共 API 仅支持通过 `EngineOptions.sandbox` 选择/提示后端。

---

## Provider 概览

| Provider | 平台 | 隔离性 | 大小开销 | 性能 |
|---|---|---|---|---|
| JSC Native | iOS / macOS | 完全 | 0 KB | 优秀 |
| Hermes Native | React Native (Hermes) | 完全 | 0 KB | 优秀 |
| QuickJS Native | 所有 React Native 平台 | 完全 | ~200 KB | 非常好 |
| QuickJS WASM | Web | 强 | ~300 KB | 非常好 |
| Node VM | Node / Bun | 强 | 0 KB | 优秀 |

---

## JSC Native

使用 Apple 平台上可用的平台 JavaScriptCore 引擎。无需打包额外的二进制文件,因为 JSC 随 iOS 和 macOS 一起发布。

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'jsc',
  // ...
});
```

**特点:**

- 通过专用的 `JSGlobalContextRef` 实现完全进程级隔离。
- 零额外二进制大小 -- 依赖系统 JSC 框架。
- 当 Hermes 不是活动运行时,在 Apple 平台上的最佳选择。

---

## Hermes Native

使用 React Native 附带的 Hermes 引擎。当 host 应用已在 Hermes 上运行时,此 provider 重用相同的引擎二进制,避免任何额外开销。

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'hermes',
  // ...
});
```

**特点:**

- 通过独立的 Hermes 运行时实例实现完全隔离。
- 当 host 应用使用 Hermes 时,零额外二进制大小。
- 支持**字节码预编译**（内部实现）。公共 API 目前仅通过 `EngineOptions.sandbox` 选择后端；provider 级字节码接口不对外暴露。

---

## QuickJS Native

一个轻量级、可嵌入的 JavaScript 引擎,编译为原生库。可在所有 React Native 平台上工作,无论 host 应用使用哪个 JS 引擎。

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'quickjs',
  // ...
});
```

**特点:**

- 在专用的 QuickJS 运行时上下文中实现完全隔离。
- 增加约 200 KB 二进制大小。
- 当 JSC 和 Hermes provider 都不合适时的良好备选方案。

---

## QuickJS WASM

QuickJS 的 WebAssembly 构建,用于浏览器和 web-worker 环境。

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'wasm-quickjs',
  // ...
});
```

**特点:**

- 通过 WebAssembly 沙箱边界实现强隔离。
- 约 300 KB WASM 二进制文件(gzip 压缩效果好)。
- 该后端目前主要用于内部测试；配置项可能会调整。

---

## Node VM

使用内置的 `node:vm` 模块。可在 Node.js 和 Bun 环境中使用 -- 主要用于服务端渲染、测试和开发。

```ts
import { Engine } from 'rill/host';

const engine = new Engine({
  sandbox: 'vm',
  // ...
});
```

**特点:**

- 通过带有冻结全局对象的 `vm.createContext` 实现强隔离。
- 零额外二进制大小。
- 不适合生产移动部署;专为服务器、测试和开发使用而设计。

---

## DefaultProvider 自动选择

当未提供显式的 `sandbox` 选项时,Rill 使用以下优先级自动选择最佳可用 provider:

| 条件 | 选择的 Provider |
|---|---|
| React Native with Hermes (`RILL_SANDBOX_ENGINE=hermes`) | `HermesProvider` |
| Apple 平台 (iOS / macOS) | `JSCProvider` |
| 任何其他 React Native 平台 | `QuickJSProvider` |
| Node.js 或 Bun 运行时 | `VMProvider` |
| Web 浏览器 | `QuickJSNativeWASMProvider` |

自动选择在引擎创建时运行一次。您可以通过显式传递 `sandbox` 选项来覆盖它。

---

## 配置

`EngineOptions` 中的 `sandbox` 字段接受以下字符串值:

| 值 | Provider |
|---|---|
| `'jsc'` | JSC Native |
| `'hermes'` | Hermes Native |
| `'quickjs'` | QuickJS Native |
| `'wasm-quickjs'` | QuickJS WASM |
| `'vm'` | Node VM |
| `'orchestrator'` | Native Orchestrator (多租户模式) |
| `'none'` | 无沙箱 -- 在 host 上下文中执行(仅开发) |

```ts
const engine = new Engine({
  sandbox: 'quickjs',
  // other options...
});
```

---

## 性能比较

### 初始化时间

| Provider | 冷启动 | 热启动 |
|---|---|---|
| JSC Native | ~2 ms | < 1 ms |
| Hermes Native | ~2 ms | < 1 ms |
| Hermes (字节码) | < 1 ms | < 1 ms |
| QuickJS Native | ~5 ms | ~2 ms |
| QuickJS WASM | ~15 ms | ~5 ms |
| Node VM | ~1 ms | < 1 ms |

### 函数调用开销 (host-to-sandbox 往返)

| Provider | 延迟 |
|---|---|
| JSC Native | ~0.01 ms |
| Hermes Native | ~0.01 ms |
| QuickJS Native | ~0.02 ms |
| QuickJS WASM | ~0.05 ms |
| Node VM | ~0.01 ms |

### 内存基线 (空沙箱上下文)

| Provider | 基线 |
|---|---|
| JSC Native | ~1.5 MB |
| Hermes Native | ~1.2 MB |
| QuickJS Native | ~0.5 MB |
| QuickJS WASM | ~0.8 MB |
| Node VM | ~2.0 MB |
