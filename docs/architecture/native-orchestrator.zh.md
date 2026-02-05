# C++ 原生 Orchestrator

原生 orchestrator 是一个 C++ 单例,提供多租户沙箱管理、线程隔离、资源配额和集中协调。它作为 JSI HostObject 安装在 React Native host 运行时中。

## 设计动机

- **性能** -- 原生 C++ 避免了 TypeScript 在热路径生命周期管理、线程调度和定时器操作方面的开销。
- **线程隔离** -- 每个租户都有专用的执行线程,具有自己的运行循环,确保慢速或失控的 guest 不会阻塞其他租户或 host UI 线程。
- **多租户协调** -- 跨所有活动租户的集中资源跟踪、事件总线和安全执行。

## 组件概述

### RillOrchestrator (`native/core/src/RillOrchestrator.h`)

通过 `jsi::HostObject` 作为 `globalThis.__RillOrchestrator` 安装的单例。所有方法都通过 JSI `get()` 接口公开,可从 TypeScript 调用。

主要职责:
- 租户生命周期(创建、加载、暂停、恢复、销毁)
- Host 回调路由(onBatch、onEvent、onError、onLog、onTimer)
- 每个租户的上下文操作(eval、inject、extract)用于 TS Engine 委托
- EventBus JSI 方法(publish、subscribe、broadcast、unicast、multicast)
- 权限和配额查询
- 指标收集

### TenantRegistry (`native/core/src/TenantRegistry.h`)

跟踪租户状态和元数据。提供按 `TenantId` 查找和基于状态的查询(例如,所有正在运行的租户,所有暂停的租户)。

### TenantHandle (`native/core/src/TenantHandle.h`)

每个租户的包装器,拥有:
- `TenantContext` -- 元数据、资源配额、状态机
- 沙箱运行时和上下文(引擎特定: JSC、QuickJS 或 Hermes)
- 用于线程安全访问的互斥锁

提供委托给底层沙箱引擎的 `eval`、`inject`、`extract` 和 `dispose` 操作。

### TenantThread (`native/core/src/TenantThread.h`)

每个租户的专用执行线程。特性:
- 具有四个级别的优先级队列: `Immediate`、`High`、`Normal`、`Low`
- 相同优先级内的 FIFO 排序(序列计数器)
- `TimerWheel` 集成用于原生定时器调度
- `post(task, priority)` 用于异步任务提交
- `runSync<R>(task)` 用于同步执行并返回结果(阻塞调用者)
- 定时器委托: `scheduleTimeout`、`scheduleInterval`、`cancelTimer`、`pauseTimers`、`resumeTimers`

### ThreadPool (`native/core/src/ThreadPool.h`)

管理租户线程创建和销毁。提供线程重用和有序关闭。

### TimerWheel (`native/core/src/TimerWheel.h`)

每个线程的原生定时器调度。每个租户线程拥有一个管理 `setTimeout` 和 `setInterval` 回调的 `TimerWheel`,而不依赖于 host 的定时器基础设施(在 XPC 上下文中可能会停滞)。

## 租户生命周期

### 状态机

```
Created -> Loading -> Running -> Paused -> Destroying -> Destroyed
                        |                      ^
                        +----> Error ----------+
```

### API

| 方法 | 描述 |
|---|---|
| `createTenant(config)` | 分配 TenantId,创建 TenantHandle + TenantThread |
| `loadBundle(tenantId, code)` | 将 bundle 执行任务发布到租户线程 |
| `pauseTenant(tenantId)` | 冻结定时器,排队传入事件 |
| `resumeTenant(tenantId)` | 解冻定时器,重放缓冲事件 |
| `destroyTenant(tenantId)` | 清理资源,加入线程,取消订阅 EventBus |

### 租户配置

```cpp
struct TenantConfig {
  std::string appId;          // 唯一的应用程序标识符
  ResourceQuota quota;        // 内存、CPU、定时器限制
  std::vector<std::string> apis;  // 允许的 API 能力
  bool debug = false;         // 启用调试日志
  double timeout = 0;         // Bundle 执行超时(0 = 无)
};
```

## 线程模型

每个租户拥有一个线程,具有:
- **运行循环** -- 基于优先级的任务队列,带条件变量唤醒
- **JS 运行时** -- 隔离的沙箱引擎实例
- **TimerWheel** -- 原生定时器调度
- **消息队列** -- 从其他线程发布的任务

### 跨线程通信

```
Host VM Thread                    Tenant Thread
     |                                |
     |  TenantThread::post(task)      |
     |  ------------------------------>
     |                                |  (执行任务)
     |                                |
     |  CallInvoker::invokeAsync()    |
     <-------------------------------
     |  (将结果传递给 Host)            |
```

**关键约束:** `jsi::Value` 对象不能跨线程。线程之间传递的所有数据都序列化为 `std::string`(默认协议中的 JSON,P3 协议中的二进制 `ArrayBuffer`)。

### 任务优先级

| 优先级 | 用例 |
|---|---|
| `Immediate` | 销毁命令,强制清理 |
| `High` | 用户发起的事件(onPress 等) |
| `Normal` | Bundle 执行,定时器回调 |
| `Low` | 诊断收集,指标 |

## JSI 绑定

在 TurboModule 初始化期间,orchestrator 安装在 host 运行时中:

```cpp
RillOrchestrator::install(hostRuntime, callInvoker);
```

这创建了一个单例 `RillOrchestrator` 并将其设置为 `globalThis.__RillOrchestrator`。所有方法都通过 `jsi::HostObject::get()` 接口公开:

```
__RillOrchestrator.createTenant(config)
__RillOrchestrator.loadBundle(tenantId, code)
__RillOrchestrator.destroyTenant(tenantId)
__RillOrchestrator.sendEvent(tenantId, name, payload)
__RillOrchestrator.evalInTenant(tenantId, code)
__RillOrchestrator.setTenantGlobal(tenantId, name, value)
__RillOrchestrator.getTenantGlobal(tenantId, name)
__RillOrchestrator.setHostCallbacks(callbacks)
__RillOrchestrator.getMetrics()
// ... EventBus 方法、定时器方法等
```

Host 回调(`onBatch`、`onEvent`、`onError`、`onLog`、`onTimer`)是通过 `setHostCallbacks` 注册的 `jsi::Function` 对象。它们通过 `CallInvoker::invokeAsync()` 在 Host VM 线程上调用。

## OrchestratorProvider (TypeScript 适配器)

`src/host/orchestrator/orchestrator-provider.ts` 将 JSI 接口桥接到 TypeScript。

### 检测

```typescript
static isAvailable(): boolean {
  return typeof globalThis.__RillOrchestrator !== 'undefined';
}
```

### Engine 集成

当 `globalThis.__RillOrchestrator` 可用时,`Engine` 会自动委托给它。内部适配器将原始 JSI 接口包装到 `JSEngineProvider` / `JSEngineRuntime` / `SandboxScope` 实现中:

- `createRuntime()` -- 调用 `createTenant(config)`,返回包装器
- `context.eval(code)` -- 调用 `evalInTenant(tenantId, code)`
- `context.inject(name, value)` -- 调用 `setTenantGlobal(tenantId, name, value)`
- `context.extract(name)` -- 调用 `getTenantGlobal(tenantId, name)`
- `context.dispose()` -- 调用 `destroyTenant(tenantId)`

这允许现有的 TypeScript Engine 代码透明地工作,无论是由 C++ orchestrator 还是纯 TypeScript 沙箱提供者支持。
