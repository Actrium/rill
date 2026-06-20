# Host API 参考

Host API 是在 React Native 应用程序中嵌入 Rill 的主要接口。它提供沙箱生命周期管理、组件注册、双向通信和 React 元素树渲染。

导入路径：`rill/host`

声明式渲染与默认组件预设在：`rill/host/preset`。

---

## Engine

`Engine` 类创建并管理一个隔离的 JS 沙箱。每个 Engine 实例拥有一个专用的 JS 运行时，以及一套 Host↔Guest 通信/渲染管线。

### 构造函数

```typescript
new Engine(options?: EngineOptions)
```

### EngineOptions

| 属性 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `sandbox` | `'vm' \| 'jsc' \| 'quickjs' \| 'hermes' \| 'wasm-quickjs' \| 'tenant-manager'` | 自动检测 | 明确选择沙箱后端。 |
| `tenant manager` | `TenantConfig` | `undefined` | 使用 TenantManager 沙箱时的租户配置。 |
| `timeout` | `number` | `5000` | 执行超时时间（毫秒）。 |
| `debug` | `boolean` | `false` | 启用调试日志。 |
| `logger` | `{ log, warn, error }` | `console` | 自定义日志实现。 |
| `requireWhitelist` | `readonly string[]` | `['react', 'react-native', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'rill/guest', 'rill/reconciler']` | 沙箱 `require()` 允许的模块名称。支持简单的尾部 `*` 前缀匹配（例如 `rill/*`）。 |
| `onMetric` | `(name: string, value: number, extra?: Record<string, unknown>) => void` | `undefined` | 性能指标报告回调。 |
| `receiverMaxBatchSize` | `number` | `5000` | Receiver 应用的每批次最大操作数。超出的操作将被跳过以保护 Host 性能。 |
| `diagnostics` | `{ activityWindowMs?, activityHistoryMs?, activityBucketMs? }` | 见下文 | Host 侧监控的诊断参数。 |
| `devtools` | `boolean \| RuntimeCollectorConfig` | `undefined` | 启用 DevTools 集成。传递 `true` 使用默认值，或传递对象进行自定义配置。 |

**诊断默认值：**

| 属性 | 默认值 | 描述 |
|---|---|---|
| `activityWindowMs` | `5000` | 用于计算 ops/s 和 batch/s 的统计窗口。 |
| `activityHistoryMs` | `60000` | 用于时间线聚合的活动采样保留时长。 |
| `activityBucketMs` | `2000` | 时间线桶宽度。 |

### 属性

| 属性 | 类型 | 描述 |
|---|---|---|
| `id` | `readonly string` | 唯一引擎标识符（格式：`engine-{counter}-{timestamp}-{random}`）。 |
| `isLoaded` | `boolean` | 是否已成功加载 Guest bundle。 |
| `isDestroyed` | `boolean` | 引擎是否已被销毁。 |
| `isPaused` | `boolean` | 引擎当前是否已暂停。 |

### 方法

#### register(components)

注册 Host 侧组件实现。

```typescript
engine.register(components: ComponentMap): void
```

- `components` -- 将组件名称（字符串）映射到 React 组件实现的对象。

#### loadBundle(source, initialProps?)

在沙箱中加载并执行 Guest bundle。

```typescript
engine.loadBundle(source: string, initialProps?: Record<string, unknown>): void | Promise<void>
```

- `source` -- Bundle 源代码字符串，或用于获取 bundle 的 URL（`http://` / `https://`）。
- `initialProps` -- 通过 `useConfig()` 传递给 Guest 的初始配置。
- 对于同步提供者（JSC）与内联代码返回 `void`，对于异步提供者或远程 URL 返回 `Promise<void>`。
- 如果引擎已加载或已销毁，则抛出错误。

#### sendEvent(name, payload?)

向沙箱 Guest 发送事件。如果引擎已暂停，事件将被排队并在恢复时传递。

```typescript
engine.sendEvent(eventName: string, payload?: unknown): void
```

#### updateConfig(config)

更新 Guest 配置。触发向沙箱发送 `CONFIG_UPDATE` 消息。

```typescript
engine.updateConfig(config: BridgeValueObject): void
```

- 默认 Guest runtime 会将该消息转发为一个 `CONFIG_UPDATE` Host event（Guest 可通过 `useHostEvent('CONFIG_UPDATE', ...)` 订阅）。
- 如果 Guest 已经至少渲染过一次，runtime 还会触发一次重渲染，从而使 `useConfig()` 读取到最新值。

#### on(event, handler)

订阅引擎事件。返回取消订阅函数。

```typescript
engine.on<K extends keyof EngineEvents>(
  event: K,
  listener: (data: ...) => void
): () => void
```

#### pause()

暂停引擎。冻结所有计时器并排队传入事件。

```typescript
engine.pause(): void
```

#### resume()

恢复引擎。解冻计时器（从剩余时间继续）并刷新排队的事件。

```typescript
engine.resume(): void
```

#### destroy()

销毁引擎并释放所有资源。触发 `destroy` 事件，清除计时器，释放沙箱运行时，并清理所有内部状态。

```typescript
engine.destroy(): void
```

#### 可观测性（可选）

用于监控与调试：

```typescript
engine.getHealth(): EngineHealth;
engine.getResourceStats(): { timers: number; nodes: number; callbacks: number };
engine.getDiagnostics(): EngineDiagnostics;
```

### 事件

使用 `engine.on(event, handler)` 订阅事件。

| 事件 | 负载 | 描述 |
|---|---|---|
| `load` | （无） | Guest bundle 已成功加载并执行。 |
| `error` | `Error` | 沙箱中发生了非致命错误。 |
| `fatalError` | `Error` | 发生了不可恢复的错误（例如超时）。引擎将自动销毁。 |
| `destroy` | （无） | 引擎已被销毁。 |
| `message` | `GuestMessage` | Guest 通过 `useSendToHost()` 发送了自定义消息。 |
| `pause` | （无） | 引擎已暂停。 |
| `resume` | （无） | 引擎已恢复。 |
| `devtoolsConsole` | `DevToolsConsoleEntry` | 来自 Guest 沙箱的控制台日志（需要启用 DevTools）。 |
| `devtoolsError` | `DevToolsError` | 来自 Guest 沙箱的错误（需要启用 DevTools）。 |
| `devtoolsReady` | `Record<string, unknown>` | Guest DevTools 已就绪。 |

还有一些面向高级集成/工具链的事件（例如底层操作批次）。除非你在构建自定义工具，否则优先使用 `EngineView` / `useEngineView`。

---

## EngineView

**导入路径：** `rill/host/preset`

一个提供 Engine 生命周期管理和渲染声明式接口的 React Native 组件。

### Props

| Prop | 类型 | 必需 | 描述 |
|---|---|---|---|
| `engine` | `Engine` | 是 | 要使用的 Engine 实例。 |
| `source` | `string` | 是 | Bundle 源代码或 URL。 |
| `initialProps` | `Record<string, unknown>` | 否 | Guest 的初始配置。 |
| `onLoad` | `() => void` | 否 | bundle 成功加载时调用。 |
| `onError` | `(error: Error) => void` | 否 | 发生错误时调用。 |
| `onDestroy` | `() => void` | 否 | 引擎销毁时调用。 |
| `fallback` | `ReactElement` | 否 | bundle 加载时渲染的内容。 |
| `renderError` | `(error: Error) => ReactElement` | 否 | 自定义错误渲染函数。 |
| `style` | `ViewStyle` | 否 | 应用于容器视图的样式。 |

---

## useEngineView（可选）

导入路径：`rill/host`

用于自定义 `EngineView` 实现的 Hook。

## 内部实现（不导出）

以下概念存在于实现中，但**不属于公共包 API**，可能随时变更：

- `Receiver`（将操作批次构建为元素树）
- `ComponentRegistry`（组件名白名单/映射）
- `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope`（provider 层）
- Bridge 协议类型，例如 `OperationBatch` / `HostMessage`
- 特化错误类，例如 `RequireError` / `ExecutionError` / `TimeoutError`
