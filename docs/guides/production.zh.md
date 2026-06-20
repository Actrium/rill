# 生产部署

本指南介绍在生产环境中部署 Rill 的配置、加固、监控和优化实践。

---

## 运行时加固

### 模块白名单

`requireWhitelist` 选项限制 guest 代码可以导入哪些模块。任何针对列表之外模块的 `require()` 或 `import` 调用都会抛出 `RequireError`。

```ts
const engine = new Engine({
  requireWhitelist: [
    'react',
    'react-native',
    'react/jsx-runtime',
    'rill/guest',
    'rill/*',
  ],
  // ...
});
```

默认白名单包含上述条目。`rill/*` 模式匹配所有 `rill/` 子路径。

### 执行超时

`timeout` 选项设置 guest bundle 在初始评估期间或从 host 的任何单次同步调用期间可以花费的最大挂钟时间(毫秒)。

```ts
const engine = new Engine({
  timeout: 5000, // 默认
  // ...
});
```

对于 QuickJS provider,超时强制执行是尽力而为的,因为 QuickJS 在所有情况下都不支持从另一个线程进行抢占式中断。

### 错误分类

Rill 将沙箱错误分类为明确定义的类型:

| 错误类 | 含义 |
|---|---|
| `RequireError` | Guest 尝试导入不在白名单中的模块。 |
| `ExecutionError` | Bundle 评估或回调调用期间的未捕获异常。 |
| `TimeoutError` | 执行超过配置的超时时间。 |

所有错误类型都包含原始堆栈跟踪(如果可用)和用于关联的引擎实例 ID。

### 批处理限制

Receiver 批量处理来自沙箱的 UI 指令。`receiverMaxBatchSize` 选项限制单个批次中处理的指令数量,以防止 host 线程被行为不当的 guest 阻塞。

```ts
const engine = new Engine({
  receiverMaxBatchSize: 5000, // 默认
  // ...
});
```

---

## 指标与可观测性

### onMetric 回调

传递一个 `onMetric` 回调以接收关键引擎操作的时间和计数数据:

```ts
const engine = new Engine({
  onMetric: (name: string, value: number, tags?: Record<string, string>) => {
    telemetry.record(name, value, tags);
  },
  // ...
});
```

#### 指标名称

| 指标 | 单位 | 描述 |
|---|---|---|
| `engine.resolveSource` | ms | 解析 bundle 源的时间(URL 解析、缓存查找)。 |
| `engine.fetchBundle` | ms | 通过网络获取 bundle 内容的时间。 |
| `engine.initializeRuntime` | ms | 创建和配置沙箱运行时的时间。 |
| `engine.executeBundle` | ms | 在沙箱内评估 guest bundle 的时间。 |
| `engine.sendToSandbox` | ms | 单次 host-to-sandbox 消息往返的时间。 |
| `receiver.applyBatch` | ms | 在 host 上应用一批 UI 指令的时间。 |
| `receiver.render` | ms | host reconciler 提交渲染过程的时间。 |

### 结构化日志记录器

`logger` 选项接受用于引擎级日志输出的结构化日志记录器对象:

```ts
const engine = new Engine({
  logger: {
    debug: (msg, data) => { /* ... */ },
    info:  (msg, data) => { /* ... */ },
    warn:  (msg, data) => { /* ... */ },
    error: (msg, data) => { /* ... */ },
  },
  // ...
});
```

---

## 健康检查 API

### 引擎健康

```ts
const health = engine.getHealth();
```

```ts
interface EngineHealth {
  loaded: boolean;        // 如果 bundle 已成功加载则为 true
  destroyed: boolean;     // 如果调用了 engine.destroy() 则为 true
  errorCount: number;     // 自创建以来的总错误数
  lastErrorAt: number;    // 最近错误的时间戳(ms),或 0
  receiverNodes: number;  // receiver 当前跟踪的节点数
}
```

### 资源统计

```ts
const stats = engine.getResourceStats();
```

```ts
interface ResourceStats {
  timers: number;      // 活动的 setTimeout / setInterval 句柄
  nodes: number;       // receiver 树中的活动 UI 节点
  callbacks: number;   // 注册的回调句柄
}
```

使用这些端点构建活性探针或仪表板面板,与您的应用程序指标一起显示沙箱健康状况。

---

## 安全隔离

### 沙箱 Provider 选择

为您的部署目标选择具有适当隔离级别的沙箱后端（通过 `EngineOptions.sandbox`）。有关完整比较，请参阅[沙箱提供者](./sandbox-providers.zh.md) 指南。在生产移动部署中，首选 JSC Native、Hermes Native 或 QuickJS Native 以实现完全进程级隔离。

### 模块访问白名单

始终保持 `requireWhitelist` 尽可能窄。除非 guest bundle 明确依赖它们,否则不要将模块添加到白名单。

### 回调载荷验证

通过回调从沙箱返回的数据在转发到 host 代码之前会根据引擎的 `TypeRules` 进行验证。循环引用、函数和其他不可序列化的值会被拒绝。

---

## 性能优化

### ThrottledScheduler

引擎内部使用 `ThrottledScheduler` 将快速连续的 UI 更新序列合并为更少的协调过程。这减少了同步 bridge 交叉的次数,并保持 host 线程的响应性。

### OperationMerger

对同一节点的连续操作(例如,多次 `setProp` 调用)在分派之前会合并为单个指令。这对 guest 代码是透明的,并减少了指令批次大小。

### FlatList 虚拟化

当 guest 代码渲染大型可滚动列表时,host 端的 `FlatList` 组件应用标准的 React Native 虚拟化。只有可见窗口内的项目被挂载,无论列表长度如何,都能保持节点数量和内存使用受限。

---

## 内存管理

### 销毁引擎

当不再需要引擎实例时,始终调用 `engine.destroy()`。这会释放沙箱运行时,取消待处理的定时器,排空回调注册,并删除所有 receiver 节点。

```ts
engine.destroy();
```

### useEffect 清理模式

在 React 组件中使用 Rill 时,在 `useEffect` 的清理函数中销毁引擎:

```ts
useEffect(() => {
  const engine = new Engine({ /* ... */ });
  engine.load(bundleSource);

  return () => {
    engine.destroy();
  };
}, []);
```

在卸载时未能销毁引擎将导致沙箱运行时和所有相关内存泄漏。

---

## 集成检查清单

在发布到生产之前,请验证以下内容:

- 选择了具有完全隔离的沙箱 provider(不是 `'none'`)。
- `requireWhitelist` 已显式设置,并且仅包含 guest 需要的模块。
- `timeout` 配置了适合 bundle 复杂度的值。
- 如果 guest 产生大型渲染批次,则调整了 `receiverMaxBatchSize`。
- `onMetric` 已连接到您的遥测系统。
- `logger` 已连接到您的结构化日志记录管道。
- 在组件卸载或不再需要引擎时调用 `engine.destroy()`。
- Bundle 已通过 `rill analyze`,没有违规。
- 健康检查(`getHealth`、`getResourceStats`)已集成到监控仪表板。
- 错误处理涵盖 `RequireError`、`ExecutionError` 和 `TimeoutError`。
