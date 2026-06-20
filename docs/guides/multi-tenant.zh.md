# 多租户模式 (Orchestrator)

Orchestrator 是一个 C++ 原生模块,用于在单个应用程序内管理多个隔离的沙箱。每个沙箱称为一个 **tenant**,在专用线程上运行自己的 guest bundle,具有独立的资源配额、定时器和生命周期管理。

---

## 概览

多租户模式专为需要同时运行多个独立 guest bundle 的应用程序设计 -- 例如,在同一屏幕上渲染多个动态 UI 卡片,每个卡片由不同团队编写或从不同来源加载。

Orchestrator 提供:

- 每个 tenant 的生命周期管理(创建、加载、暂停、恢复、销毁)。
- 每个 tenant 的资源配额(堆大小、定时器数量、回调数量)。
- 用于高精度定时器调度的原生 TimerWheel,不会阻塞 host。
- 用于跨 tenant 和系统级通信的 EventBus。
- 所有 tenant 的聚合指标。

---

## 创建 Tenant

通过向 Orchestrator 传递配置对象来创建 tenant:

```ts
interface OrchestratorTenantConfig {
  appId: string;          // 此 tenant 的唯一标识符
  debug?: boolean;        // 启用调试日志(默认 false)
  timeout?: number;       // 执行超时时间(毫秒)(默认 5000)
  quota?: {
    maxHeapBytes?: number;    // 默认 64 MB
    maxTimers?: number;       // 默认 1000
    maxCallbacks?: number;    // 默认 10000
  };
  apis?: Record<string, Function>;  // 注入到此 tenant 的 Host API
}
```

```ts
const tenantId = orchestrator.createTenant({
  appId: 'promo-card',
  timeout: 3000,
  quota: {
    maxHeapBytes: 32 * 1024 * 1024,  // 32 MB
    maxTimers: 500,
    maxCallbacks: 5000,
  },
  apis: {
    fetchProductData: async (sku: string) => { /* ... */ },
  },
});
```

---

## Tenant 生命周期

每个 tenant 经历一组明确定义的状态:

```
Created --> Loading --> Running --> Paused --> Running --> Destroying --> Destroyed
                  \                                /
                   -------> Error ----------------->
```

### 状态

| 状态 | 描述 |
|---|---|
| `Created` | Tenant 已分配,沙箱尚未初始化。 |
| `Loading` | Bundle 正在被获取并在沙箱内执行。 |
| `Running` | Bundle 成功执行,tenant 处于活动状态并正在渲染。 |
| `Paused` | Tenant 被暂停。定时器被冻结,回调被排队。 |
| `Error` | 发生了不可恢复的错误。可以销毁 tenant。 |
| `Destroying` | 清理正在进行中(定时器已取消,回调已排空)。 |
| `Destroyed` | 所有资源已释放。tenant ID 可以重用。 |

### 生命周期操作

```ts
// 加载并启动 bundle
await orchestrator.loadBundle(tenantId, bundleSource);

// 暂停(例如,当屏幕切换到后台时)
orchestrator.pauseTenant(tenantId);

// 恢复
orchestrator.resumeTenant(tenantId);

// 销毁
orchestrator.destroyTenant(tenantId);
```

---

## 资源配额

配额防止任何单个 tenant 消耗不成比例的资源。

### 配置

| 配额 | 默认值 | 描述 |
|---|---|---|
| `maxHeapBytes` | 64 MB | 沙箱可分配的最大堆内存。 |
| `maxTimers` | 1000 | 最大活动定时器数量(`setTimeout` / `setInterval`)。 |
| `maxCallbacks` | 10000 | 最大注册的回调句柄数量。 |

### 监控

```ts
const info = orchestrator.getTenantInfo(tenantId);
// { appId, state, heapUsed, timerCount, callbackCount, ... }

orchestrator.isOverQuota(tenantId);   // 如果任何限制超出则返回 true
orchestrator.isNearQuota(tenantId);   // 如果任何限制 > 80% 则返回 true
```

### 违规跟踪

Orchestrator 记录每个 tenant 的配额和策略违规:

| 违规类型 | 触发条件 |
|---|---|
| `componentDenied` | Guest 尝试渲染不在允许集合中的组件。 |
| `apiDenied` | Guest 调用了未在 `apis` 中提供的 host API。 |
| `quotaExceeded` | 资源配额被超出。 |

违规可通过 `getTenantInfo(tenantId).violations` 获取。

---

## 定时器管理

每个 tenant 都有自己的原生 **TimerWheel**,运行在 tenant 的专用线程上。这避免了与 host 主线程的争用,并提供微秒级精度的调度。

### API

```ts
// 一次性定时器
orchestrator.scheduleTenantTimeout(tenantId, callback, delayMs);

// 重复定时器
orchestrator.scheduleTenantInterval(tenantId, callback, intervalMs);

// 取消特定定时器
orchestrator.cancelTenantTimer(tenantId, timerId);

// 暂停 tenant 的所有定时器(在 pauseTenant 时自动调用)
orchestrator.pauseTenantTimers(tenantId);

// 恢复所有定时器(在 resumeTenant 时自动调用)
orchestrator.resumeTenantTimers(tenantId);
```

当 tenant 被暂停时,其定时器会冻结。暂停期间的已用时间不计入待处理的超时。

---

## 跨 Tenant 通信 (EventBus)

EventBus 允许 tenant(和 host)通过命名通道交换消息。

### 发布

```ts
// 发布到特定通道(传递给所有订阅者)
orchestrator.busPublish(channel, payload);

// 广播到所有通道上的所有 tenant
orchestrator.busBroadcast(payload);

// 发送到单个 tenant
orchestrator.busUnicast(tenantId, channel, payload);

// 发送到一组 tenant
orchestrator.busMulticast([tenantIdA, tenantIdB], channel, payload);
```

### 通道策略

每个通道可以配置一个策略对象:

| 策略 | 类型 | 描述 |
|---|---|---|
| `systemOnly` | `boolean` | 只有 host 可以发布到此通道。 |
| `requirePermission` | `boolean` | Tenant 必须被授予显式访问权限。 |
| `maxSubscribers` | `number` | 最大并发订阅者数量。 |
| `maxEventsPerSecond` | `number` | 已发布事件的速率限制。 |
| `maxPayloadBytes` | `number` | 最大序列化载荷大小。 |
| `persistent` | `boolean` | 新订阅者接收最后发布的事件。 |

### 内置通道

| 通道 | 方向 | 描述 |
|---|---|---|
| `system` | Host 到 tenant | 系统级通知(内存警告等)。 |
| `lifecycle` | Host 到 tenant | 应用生命周期事件(前台、后台)。 |
| `network.status` | Host 到 tenant | 网络连接变化。 |
| `tenant.messages` | Tenant 到 tenant | 通用的 tenant 间消息传递。 |

---

## 指标

Orchestrator 公开聚合指标用于监控:

```ts
const metrics = orchestrator.getMetrics();
```

```ts
interface OrchestratorMetrics {
  totalTenants: number;     // 创建的总 tenant 数(包括已销毁的)
  registryTotal: number;    // 注册表中的当前 tenant 数
  registryActive: number;   // 处于 Running 或 Paused 状态的 tenant 数
  running: number;          // 处于 Running 状态的 tenant 数
  paused: number;           // 处于 Paused 状态的 tenant 数
  error: number;            // 处于 Error 状态的 tenant 数
  activeThreads: number;    // tenant 当前使用的 OS 线程数
}
```
