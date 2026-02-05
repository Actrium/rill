# Guest 运行时架构

guest 运行时是在沙箱化的 JavaScript 引擎内执行的代码。它提供 React、SDK、reconciler 以及 guest 应用程序以声明方式渲染 UI 所需的所有支持基础设施。

## 两阶段架构

### 构建阶段

构建阶段将整个 guest 运行时编译为单个 IIFE 字符串常量(`GUEST_BUNDLE_CODE`),可以在任何 JavaScript 沙箱中评估。

**入口点:** `scripts/build-guest-bundle.ts`
**输入:** `src/guest/bundle.ts`
**输出:** `src/guest/build/bundle.ts`(导出为 `GUEST_BUNDLE_CODE`)

构建过程:
1. 解析来自 `src/guest/runtime/`、`src/sdk/`、`src/shared/` 的所有导入
2. 将 React(轻量级 shim)、SDK、Reconciler 和共享协议打包到单个模块中
3. 将所有内容包装在 IIFE 中以避免污染全局作用域
4. 压缩和 tree-shake 以优化大小
5. 转译为 ES5 以获得最大的沙箱兼容性(QuickJS、JSC、较旧的 Hermes)

这种预打包方法提供:
- **启动性能** -- 单次 eval 而不是多次 require/eval 调用
- **版本一致性** -- Guest React 和 reconciler 版本锁定在一起
- **大小优化** -- 死代码在构建时被消除

### 运行时阶段

当调用 `Engine.loadBundle` 时,运行时注入遵循严格的序列。

## 运行时注入序列

注入的顺序至关重要。每个步骤都依赖于前面步骤建立的全局变量。

### 步骤 1: Console 设置

单独的 console 方法作为单独的全局变量注入(`__console_log`、`__console_warn`、`__console_error`、`__console_debug`、`__console_info`),因为 JSC 沙箱无法处理通过 RN bridge 传递的带有函数属性的对象。guest bundle 从这些原语构造一个适当的 `console` 对象。

### 步骤 2: Timer Polyfills

在 guest bundle 之前注入 `setTimeout`、`clearTimeout`、`setInterval`、`clearInterval`、`setImmediate`、`clearImmediate` 和 `queueMicrotask`,因为 React 的调度器在初始化期间需要 `setImmediate`。

`setImmediate` 实现使用带有显式排空的同步回调队列。这避免了依赖 host 的 `queueMicrotask`(在 RCTTiming 被冻结的 XPC ViewBridge 上下文中排空太晚)。

### 步骤 3: GUEST_BUNDLE_CODE

评估预构建的 IIFE,建立:
- `React` 和 `ReactJSXRuntime` / `ReactJSXDevRuntime` 全局变量(轻量级 shim)
- `RillGuest` 全局变量(组件构造器和钩子)
- `RillReconciler` 全局变量(reconciler API: `render`、`invokeCallback`、`releaseCallback` 等)
- `__rillHooks` 状态对象用于 useState/useEffect
- `__rill.callbacks` Map 用于函数注册
- `__rill.registerCallback`、`__rill.invokeCallback`、`__rill.dispatchEvent` 运行时助手

### 步骤 4: require() 模块加载器

注入一个白名单的 `require()` 函数。它正好支持这些模块:
- `react` -- 返回沙箱中的 `React` 全局变量
- `react-native` -- 返回一个最小的 RN shim
- `react/jsx-runtime` 和 `react/jsx-dev-runtime` -- 返回 JSX 运行时 shim
- `rill/reconciler` -- 返回带有 Engine 绑定的 `render` 和 `scheduleRender` 的 `RillReconciler`
- `rill/guest` -- 返回 `RillGuest`

任何其他模块名称都会抛出 `RequireError`。

### 步骤 5: 运行时 API 注入

Engine 提供的全局变量:
- `__rill_sendBatch(batch)` -- 通过 Bridge 将操作批次路由到 Receiver
- `__rill_sendOperation(op)` -- 立即发送单个操作(由 Remote Ref 使用)
- `__rill_getConfig()` -- 返回初始配置
- `__rill_emitEvent(eventName, payload)` -- 向 host 发送命名事件
- `__rill_handleMessage(message)` -- 分派传入的 host 消息(CALL_FUNCTION、HOST_EVENT 等)
- `__rill_schedule_render()` -- 从 guest hooks 触发重新渲染(useState/useEffect)
- `__rill_register_component_type(fn)` -- 为 JSI 传输注册 guest 函数组件
- 组件名称全局变量(例如 `View = 'View'`、`Text = 'Text'`)用于已注册的组件类型

### 步骤 6: 用户 Bundle 执行

评估开发者的 guest 代码。通常它会调用 `require('rill/reconciler').render(element, __rill_sendBatch)` 来启动初始渲染。

在 `eval` 之后,引擎显式排空 `setImmediate` 队列,以便 React 的调度协调在 `loadBundle` 返回之前同步完成。

## Reconciler 实现

reconciler 是一个自定义的 `react-reconciler` host 配置,它将 React 树变更转换为可序列化的操作。

### 目录: `src/guest/runtime/reconciler/`

**host-config.ts** -- 实现 `react-reconciler` host config 接口:
- `createInstance(type, props)` -- 创建 VNode,编码属性(函数到 fnId),发出 `CREATE` 操作
- `createTextInstance(text)` -- 创建 `__TEXT__` VNode,发出 `CREATE` + `TEXT`
- `appendChild(parent, child)` -- 发出 `APPEND`
- `insertBefore(parent, child, beforeChild)` -- 发出 `INSERT`
- `removeChild(parent, child)` -- 发出 `REMOVE` + `DELETE`
- `commitUpdate(instance, updatePayload, ...)` -- 发出带有变化属性的 `UPDATE`
- `resetAfterCommit()` -- 触发 `OperationCollector.flush()`

**operation-collector.ts** -- 在渲染过程中累积操作,并在 commit 时将它们作为单个 `OperationBatch` 刷新。维护批次 ID 序列。

**element-transform.ts** -- 在 guest 元素进入 reconciler 之前对其进行预处理。处理:
- Fragment 展平
- 组件类型桥接(字符串名称到 reconciler 识别的类型)
- 条件渲染的标记元素

**guest-encoder.ts** -- guest 端的属性序列化:
- 函数在 `CallbackRegistry` 中注册,并被替换为 `{ __type: 'function', __fnId, __name, __sourceFile, __sourceLine }`
- 样式对象原样传递
- 嵌套结构递归编码

**binary-encoder.ts** -- 可选的二进制编码支持(P3 协议)。使用二进制指令格式将操作批次编码为 `ArrayBuffer`,以减小大小并加快传输速度。

**reconciler-manager.ts** -- 管理 reconciler 实例。缓存 reconciler 容器,以便后续的 `render` 调用重用相同的实例(启用适当的 diffing)。

**types.ts** -- VNode 类型定义,reconciler 类型别名。

## Guest SDK

### 目录: `src/sdk/`

**sdk.ts** -- 为 guest 开发者提供公共 API:
- 组件构造器: `View`、`Text`、`ScrollView`、`Image`、`TouchableOpacity`、`TextInput`、`Panel` 等。
- `useHostEvent(eventName, handler)` -- 订阅 host 事件
- `useConfig()` -- 读取当前配置
- `sendEventToHost(name, payload)` -- 向 host 发送事件
- `useRef()` -- 创建支持 Remote Ref 方法调用的 refs

**types.ts** -- 所有 SDK 组件和钩子的 TypeScript 类型定义。

**index.ts** -- 公共导出桶。

## 目录结构

```
src/guest/
  bundle.ts                     构建入口点
  build/
    bundle.ts                   预构建的 IIFE(GUEST_BUNDLE_CODE)
  runtime/
    init.ts                     Guest 初始化编排器
    globals-setup.ts            Console 和全局 shim 构造
    react-global.ts             注入 React/JSX runtime（真实 React）
    reconciler/
      host-config.ts            react-reconciler host 配置
      operation-collector.ts    操作批处理和刷新
      element-transform.ts      元素预处理
      guest-encoder.ts          属性序列化
      binary-encoder.ts         二进制协议编码
      reconciler-manager.ts     Reconciler 实例缓存
      types.ts                  VNode 和 reconciler 类型
      devtools.ts               DevTools 集成钩子
      index.ts                  公共 reconciler API

src/sdk/
  sdk.ts                        SDK 实现
  types.ts                      类型定义
  index.ts                      公共导出
```
