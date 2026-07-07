# Rill 架构概述

Rill 是一个轻量级、无头的、沙箱化的动态 UI 渲染引擎,专为 React Native 设计。它在隔离的 JavaScript 运行时中执行不受信任的 guest 代码,并将生成的 UI 描述作为原生 React Native 组件在 host 上渲染。

## 设计理念

1. **生产者-消费者模式** -- guest 沙箱生成声明式 UI 描述(操作批次),host 消费它们以渲染原生组件。双方都不直接访问对方的内存。

2. **白名单组件安全** -- 只有 host 通过 `ComponentRegistry` 明确注册的组件类型才能被渲染。未注册的类型名称将被静默丢弃,防止 guest 代码实例化任意原生视图。

3. **函数序列化** -- 回调函数不能作为活动引用跨越沙箱边界。每个函数都被分配一个唯一的 `fnId` 并被替换为 `{ __type: 'function', __fnId }` 描述符。当 host 需要调用 guest 回调(例如 `onPress`)时,它会向沙箱发送一个 `CALL_FUNCTION` 消息。

4. **批量更新优化** -- reconciler 在单个 React commit 阶段收集所有结构和属性变更,并将它们作为一个 `OperationBatch` 刷新,最小化边界跨越次数。

5. **沙箱隔离** -- guest 代码在专用的 JavaScript 引擎实例中运行(JavaScriptCore、QuickJS、Hermes、WASM 或 Node `vm`)。host 注入一组精心控制的全局变量;除非明确 polyfill,否则不提供环境 API(网络、文件系统、计时器)。

6. **每环境一个引擎** -- 每个宿主 JavaScript 环境里,一个 rill 引擎驱动一个 guest。组合*多个*应用靠隔离,而非共享环境:web 上每个应用跑在各自的 iframe(独立源、存储、CSP),原生侧每个租户跑在各自的 `TenantThread` 与独立 JS 运行时上。rill **不**追求多个独立应用引擎共存于同一个共享 JS 上下文,因此环境作用域内的模块级单例(如安装在 `globalThis` 上的 guest 回调注册表)是合理的,而非局限。在单个应用*内部*开多个 `<Canvas>` 画布是另一回事,完全支持。

## 四层架构

```
Platform Layer  (iOS / macOS / Android / Web)
  |
  +-- C++ TenantManager  (多租户管理、线程池、事件总线)
  |     |
  |     +-- Per-Tenant Sandbox  (隔离的 JS 运行时、定时器轮、安全性)
  |           |
  |           +-- Guest App  (通过 rill/guest 的 React 组件)
  |
  +-- Host Shell  (EngineView 渲染原生 React Native 组件)
```

**Platform Layer** -- 原生入口点。在 Apple 平台上,这是一个 TurboModule (`RillSandboxNativeTurboModule`),它将 C++ tenant manager 安装到 React Native host 运行时中。

**C++ TenantManager** -- 单例(`RillTenantManager`),协调租户创建、线程分配、资源配额、事件总线、安全上下文和 CDP 调试。通过 JSI HostObject 安装为 `globalThis.__RillTenantManager`。

**Per-Tenant Sandbox** -- 每个租户获得一个带有自己运行循环、`TimerWheel` 和 JS 运行时的 `TenantThread`。沙箱在完全隔离于其他租户和 host 的环境中执行 guest bundle。

**Guest App** -- 开发者编写的 React 组件,从 `rill/guest` 导入。这些被编译为自包含的 bundle 并在沙箱内评估。

**Host Shell** -- `Engine` 类管理沙箱生命周期。它的 `Receiver` 维护虚拟节点的 `nodeMap`,并将它们渲染为由 `EngineView` 消费的活动 React 元素树。

## 模块概述

```
src/
  host/               Host 运行时
    engine/              沙箱引擎核心(生命周期、polyfills、运行时 API)
      engine.ts
      types.ts           Engine 类型与对外接口
      timer-manager.ts   Timer polyfills 与调度
      diagnostics-collector.ts  活跃度/健康度追踪
      sandbox-helpers.ts Console + 全局辅助
      shims.ts           DevTools/运行时 shims
    receiver/            指令接收器(nodeMap、渲染)
      receiver.ts
      types.ts
      stats.ts
    registry.ts          ComponentRegistry(白名单)
    tenant manager/        TenantManagerProvider(C++ tenant manager 的 TS 适配器)
    preset/              内置组件预设

  guest/               Guest 运行时
    bundle.ts            编译到 GUEST_BUNDLE_CODE 的入口点
    build/bundle.ts      预构建的 IIFE 字符串(构建阶段的输出)
    runtime/
      init.ts            Guest 初始化序列
      globals-setup.ts   Console 和全局 shim 设置
      react-global.ts    沙箱的轻量级 React shim
      reconciler/        自定义 react-reconciler host config
        host-config.ts     createInstance、appendChild、commitUpdate 等
        operation-collector.ts   批量操作,在 commit 时刷新
        element-transform.ts     转换 guest 元素
        guest-encoder.ts         属性序列化(函数 -> fnId)
        binary-encoder.ts        二进制编码(P3 协议)
        reconciler-manager.ts    Reconciler 实例缓存
        types.ts                 VNode 和 reconciler 类型

  sdk/                 Guest SDK
    sdk.ts               组件构造器和钩子(useHostEvent、useConfig 等)
    types.ts             SDK 类型定义
    index.ts             公共导出

  shared/              共享协议(host 和 guest 都使用)
    types.ts             操作类型、消息类型、序列化类型
    type-rules.ts        21 条跨边界值的编码/解码规则
    callback-registry.ts 引用计数的函数注册表
    serialization.ts     createEncoder / createDecoder 工具
    bridge/
      bridge.ts          双向通信协调器
      promise-manager.ts 跨边界 promise 生命周期
      binary-protocol.ts TypeScript 二进制协议支持

  sandbox/             沙箱提供者实现
  cli/                 构建工具
  devtools/            运行时 DevTools 收集器

native/core/src/      C++ TenantManager 和支持模块
    RillTenantManager.h/.mm    单例 JSI HostObject
    TenantRegistry.h/.cpp     租户状态跟踪
    TenantHandle.h/.cpp       每个租户的包装器(运行时、上下文、状态机)
    TenantThread.h/.cpp       带优先级队列的专用执行线程
    TenantContext.h/.cpp       租户元数据和资源配额
    ThreadPool.h/.cpp          线程生命周期管理
    TimerWheel.h/.cpp          每个线程的原生定时器调度
    EventBus.h/.cpp            跨租户发布/订阅
    InstructionFormat.h        二进制线路格式定义
    InstructionEncoder.h/.cpp  C++ 二进制编码器
    InstructionDecoder.h/.cpp  C++ 二进制解码器
    InstructionCodec.h/.cpp    编解码器工具
    security/
      SecurityManager.h/.cpp   每个租户的安全上下文工厂
      NetworkSandbox.h/.cpp    域白名单、速率限制、审计
      FileSandbox.h/.cpp       路径沙箱化、配额
    devtools/
      CDPServer.h/.cpp         Chrome DevTools 协议服务器
      CDPTransportApple.h/.mm  Apple Network.framework WebSocket 传输
      ConsoleAdapter.h/.cpp    CDP Console 域
      RuntimeAdapter.h/.cpp    CDP Runtime 域
      DOMAdapter.h/.cpp        CDP DOM 域
      DebuggerAdapter.h/.cpp   CDP Debugger 域
      NetworkAdapter.h/.cpp    CDP Network 域
```

## 数据流总结

**渲染(Guest 到 Host):**

```
Guest JSX
  -> createElement
  -> React Reconciler(自定义 host-config)
  -> OperationCollector
  -> flush(sendToHost)
  -> Bridge(通过 TypeRules 编码)
  -> Receiver.applyBatch
  -> nodeMap
  -> render()
  -> React.createElement 树
  -> 原生组件
```

**事件(Host 到 Guest):**

```
Host 用户事件(例如 onPress)
  -> Receiver 在属性上找到 fnId
  -> Bridge.sendToGuest(CALL_FUNCTION)
  -> Guest __rill.invokeCallback(fnId, encodedArgs)
  -> Guest 回调执行
  -> setState / 重新渲染
  -> 新的操作批次
  -> Host Receiver 应用增量差异
```
