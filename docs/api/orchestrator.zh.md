# Orchestrator API 参考

Orchestrator 是一个通过 JSI（JavaScript Interface）暴露给 Host JS 运行时的原生 C++ 多租户沙箱管理器。它提供租户生命周期管理、每租户资源配额和权限强制执行、通过 EventBus 的跨租户通信，以及原生线程级隔离。

---

## Engine 集成

Rill 通过 `EngineOptions.sandbox = 'orchestrator'`（或自动检测）来集成 Orchestrator。内部实现上，`Engine` 会通过一个内部的 TypeScript 适配器（`src/host/orchestrator/orchestrator-provider.ts`）把沙箱操作委托给原生 `__RillOrchestrator` HostObject，但该适配器不属于对外 API。

### 检测

原生 Orchestrator 作为全局对象安装在 Host JS 运行时上：

```typescript
globalThis.__RillOrchestrator: RillOrchestratorJSI | undefined
```

若 `globalThis.__RillOrchestrator` 已定义，则 Orchestrator 可用。

### 用法

当检测到 Orchestrator 时会自动选择，或通过 `sandbox` 选项明确选择：

```typescript
// 自动检测（在 __RillOrchestrator 可用时使用）
const engine = new Engine();

// 明确选择
const engine = new Engine({
  sandbox: 'orchestrator',
  orchestrator: {
    appId: 'com.example.miniapp',
    quota: { maxHeapBytes: 16 * 1024 * 1024 },
  },
});
```

---

## RillOrchestratorJSI

原生 `__RillOrchestrator` HostObject 的完整 JSI 接口。除非另有说明，所有方法都是同步 JSI 调用。

### 租户生命周期

#### createTenant(config)

创建一个具有自己的 JS 运行时和专用线程的新隔离租户。

```typescript
createTenant(config: OrchestratorTenantConfig): number
```

返回用于对该租户的所有后续操作的租户 ID（整数）。

#### destroyTenant(tenantId)

销毁租户，释放其 JS 运行时、线程和所有相关资源。

```typescript
destroyTenant(tenantId: number): void
```

#### pauseTenant(tenantId)

暂停租户。冻结其计时器并暂停事件传递。

```typescript
pauseTenant(tenantId: number): void
```

#### resumeTenant(tenantId)

恢复暂停的租户。解冻计时器并刷新排队的事件。

```typescript
resumeTenant(tenantId: number): void
```

### 代码加载

#### loadBundle(tenantId, code)

在租户的沙箱中加载并执行 Guest bundle。

```typescript
loadBundle(tenantId: number, code: string): void
```

### 通信

#### sendEvent(tenantId, name, payload?)

向特定租户发送事件。

```typescript
sendEvent(tenantId: number, name: string, payload?: unknown): void
```

#### broadcast(name, payload?)

向所有活动租户广播事件。

```typescript
broadcast(name: string, payload?: unknown): void
```

### Host 回调

#### setHostCallbacks(callbacks)

注册从原生租户到 Host JS 运行时的事件流的回调。

```typescript
setHostCallbacks(callbacks: OrchestratorHostCallbacks): void
```

**OrchestratorHostCallbacks：**

| 回调 | 签名 | 描述 |
|---|---|---|
| `onBatch` | `(tenantId: number, batch: unknown) => void` | 来自租户协调器的操作批次。 |
| `onEvent` | `(tenantId: number, name: string, payload: unknown) => void` | 来自租户的自定义事件。 |
| `onError` | `(tenantId: number, message: string) => void` | 来自租户的错误。 |
| `onLog` | `(tenantId: number, level: string, message: string) => void` | 来自租户的日志消息。 |
| `onTimer` | `(tenantId: number, callbackId: string) => void` | 来自租户的计时器回调。 |

### 指标

#### getTenantInfo(tenantId)

获取有关特定租户的详细信息。

```typescript
getTenantInfo(tenantId: number): OrchestratorTenantInfo
```

#### getMetrics()

获取所有租户的聚合指标。

```typescript
getMetrics(): OrchestratorMetrics
```

### 每租户上下文

#### evalInTenant(tenantId, code)

在租户的沙箱上下文中评估 JavaScript 代码。

```typescript
evalInTenant(tenantId: number, code: string): unknown
```

#### setTenantGlobal(tenantId, name, value)

在租户的沙箱上下文中设置全局变量。

```typescript
setTenantGlobal(tenantId: number, name: string, value: unknown): void
```

#### getTenantGlobal(tenantId, name)

从租户的沙箱上下文中获取全局变量。

```typescript
getTenantGlobal(tenantId: number, name: string): unknown
```

### 每租户计时器

计时器在租户的专用原生线程上运行，即使 Host JS 线程繁忙也能确保准确的计时。

#### scheduleTenantTimeout(tenantId, callbackId, delayMs)

在租户的线程上调度一次性超时。

```typescript
scheduleTenantTimeout(tenantId: number, callbackId: string, delayMs: number): number
```

返回用于取消的原生计时器 ID。

#### scheduleTenantInterval(tenantId, callbackId, intervalMs)

在租户的线程上调度重复间隔。

```typescript
scheduleTenantInterval(tenantId: number, callbackId: string, intervalMs: number): number
```

返回用于取消的原生计时器 ID。

#### cancelTenantTimer(tenantId, timerId)

取消先前调度的超时或间隔。

```typescript
cancelTenantTimer(tenantId: number, timerId: number): void
```

#### pauseTenantTimers(tenantId)

暂停租户的所有计时器（时钟冻结）。

```typescript
pauseTenantTimers(tenantId: number): void
```

#### resumeTenantTimers(tenantId)

恢复租户的所有计时器（从剩余时间继续）。

```typescript
resumeTenantTimers(tenantId: number): void
```

### 权限和配额

#### canUseComponent(tenantId, componentName)

检查租户是否被允许使用特定组件。

```typescript
canUseComponent(tenantId: number, componentName: string): boolean
```

#### canUseAPI(tenantId, apiName)

检查租户是否被允许使用特定 API。

```typescript
canUseAPI(tenantId: number, apiName: string): boolean
```

#### isOverQuota(tenantId)

检查租户是否已超出其资源配额。

```typescript
isOverQuota(tenantId: number): boolean
```

#### isNearQuota(tenantId)

检查租户是否接近其资源配额（警告阈值）。

```typescript
isNearQuota(tenantId: number): boolean
```

### EventBus

EventBus 通过具有可配置策略的命名通道实现跨租户通信。

#### busPublish(event)

向 EventBus 发布事件。传递给事件通道上的所有订阅者。

```typescript
busPublish(event: BusEventData): boolean
```

如果事件被接受，则返回 `true`。

#### busBroadcast(channel, name, payload)

向通道上的所有订阅者广播系统事件。

```typescript
busBroadcast(channel: string, name: string, payload: string): boolean
```

#### busUnicast(targetTenantId, channel, name, payload)

向通道上的特定租户发送事件。

```typescript
busUnicast(targetTenantId: number, channel: string, name: string, payload: string): boolean
```

#### busMulticast(targetTenantIds, channel, name, payload)

向通道上的一组特定租户发送事件。

```typescript
busMulticast(targetTenantIds: number[], channel: string, name: string, payload: string): boolean
```

#### busSubscribe(tenantId, channel, filter)

订阅租户到通道上的事件，可选名称过滤器（正则表达式字符串）。

```typescript
busSubscribe(tenantId: number, channel: string, filter: string): number
```

返回用于稍后取消订阅的订阅 ID。

#### busUnsubscribe(subscriptionId)

取消特定订阅。

```typescript
busUnsubscribe(subscriptionId: number): void
```

#### busUnsubscribeAll(tenantId)

取消租户的所有订阅。

```typescript
busUnsubscribeAll(tenantId: number): void
```

#### busGetStats()

获取 EventBus 统计信息。

```typescript
busGetStats(): EventBusStats
```

#### busCreateChannel(policy)

使用特定策略配置创建通道。

```typescript
busCreateChannel(policy: ChannelPolicyConfig): void
```

---

## 类型定义

### OrchestratorTenantConfig

创建新租户的配置。

```typescript
interface OrchestratorTenantConfig {
  /** 此租户的唯一应用程序标识符。 */
  appId: string;

  /** 为此租户启用调试日志。 */
  debug?: boolean;

  /** 执行超时时间（毫秒）。 */
  timeout?: number;

  /** 此租户的资源配额。 */
  quota?: {
    /** 最大堆内存（字节）。 */
    maxHeapBytes?: number;

    /** 最大活动计时器数。 */
    maxTimers?: number;

    /** 最大注册回调数。 */
    maxCallbacks?: number;
  };

  /** API 白名单。空数组表示允许全部。 */
  apis?: string[];
}
```

### OrchestratorTenantInfo

由 `getTenantInfo()` 返回的有关租户的详细信息。

```typescript
interface OrchestratorTenantInfo {
  /** 租户 ID。 */
  id: number;

  /** 应用程序标识符。 */
  appId: string;

  /** 租户状态（来自原生的数字枚举）。 */
  state: number;

  /** 租户是否已被释放。 */
  disposed: boolean;

  /** 当前资源使用和限制。 */
  quota: {
    activeTimers: number;
    maxTimers: number;
    activeCallbacks: number;
    maxCallbacks: number;
    currentHeapBytes: number;
    maxHeapBytes: number;
  };

  /** 违规计数器。 */
  violations: {
    /** 被拒绝组件被访问的次数。 */
    componentDenied: number;
    /** 被拒绝 API 被访问的次数。 */
    apiDenied: number;
    /** 配额限制被超出的次数。 */
    quotaExceeded: number;
  };

  /** 租户当前是否超出其资源配额。 */
  overQuota: boolean;

  /** 租户是否接近其资源配额（警告阈值）。 */
  nearQuota: boolean;
}
```

### OrchestratorMetrics

由 `getMetrics()` 返回的所有租户的聚合指标。

```typescript
interface OrchestratorMetrics {
  /** 曾经创建的租户总数。 */
  totalTenants: number;

  /** 租户注册表中的总条目数。 */
  registryTotal: number;

  /** 注册表中活动（未释放）的租户数。 */
  registryActive: number;

  /** 处于运行状态的租户数。 */
  running: number;

  /** 处于暂停状态的租户数。 */
  paused: number;

  /** 处于错误状态的租户数。 */
  error: number;

  /** 活动原生线程数。 */
  activeThreads: number;
}
```

### EventBus 类型

#### EventPriority

EventBus 事件的优先级级别。更高优先级的事件首先传递。

```typescript
enum EventPriority {
  Critical = 0,
  High     = 1,
  Normal   = 2,
  Low      = 3,
}
```

#### BusEventData

跨租户总线事件。

```typescript
interface BusEventData {
  /** 通道名称。 */
  channel: string;

  /** 事件名称。 */
  name: string;

  /** JSON 序列化的负载。 */
  payload: string;

  /** 事件优先级。默认为 Normal。 */
  priority?: EventPriority;

  /** 源租户 ID。0 表示系统事件。 */
  sourceTenantId?: number;
}
```

#### ChannelPolicyConfig

EventBus 通道的策略配置。

```typescript
interface ChannelPolicyConfig {
  /** 通道名称。 */
  name: string;

  /** 如果为 true，则只有系统（Host）代码可以发布到此通道。 */
  systemOnly?: boolean;

  /** 如果为 true，则租户需要明确权限才能订阅。 */
  requirePermission?: boolean;

  /** 此通道上允许的最大订阅者数。 */
  maxSubscribers?: number;

  /** 速率限制：此通道上每秒的最大事件数。 */
  maxEventsPerSecond?: number;

  /** 最大负载大小（字节）。 */
  maxPayloadBytes?: number;

  /** 如果为 true，则事件将持久化并重放给新订阅者。 */
  persistent?: boolean;
}
```

#### EventBusStats

由 `busGetStats()` 返回的 EventBus 统计信息。

```typescript
interface EventBusStats {
  /** 发布的事件总数。 */
  totalPublished: number;

  /** 成功传递的事件总数。 */
  totalDelivered: number;

  /** 丢弃的事件总数（速率限制、配额等）。 */
  totalDropped: number;

  /** 当前活动订阅数。 */
  activeSubscriptions: number;

  /** 当前活动通道数。 */
  activeChannels: number;
}
```
