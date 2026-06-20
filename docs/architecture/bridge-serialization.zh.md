# Bridge 和序列化

Bridge 层处理 guest 沙箱和 host 运行时之间的所有数据编码、解码和路由。它是所有跨边界通信流过的单一点。

## 目录: `src/shared/`

| 文件 | 用途 |
|---|---|
| `types.ts` | 协议类型系统(JSISafe、BridgeValue、Operation、HostMessage 等) |
| `type-rules.ts` | 14 条有序的编码/解码规则 |
| `callback-registry.ts` | 引用计数的函数 ID 注册表 |
| `serialization.ts` | `createEncoder` / `createDecoder` 工厂函数 |
| `bridge/bridge.ts` | 双向通信协调器 |
| `bridge/promise-manager.ts` | 跨边界 promise 生命周期 |
| `bridge/binary-protocol.ts` | TypeScript 端二进制协议支持 |

## TypeRules: 递归编码

`DEFAULT_TYPE_RULES` 是一个包含 14 条规则的有序数组。编码器从上到下遍历数组并应用第一个匹配的规则。每条规则指定一个 `match` 谓词、可选的 `encode`/`decode` 转换以及传输策略(`passthrough`、`serialize` 或 `proxy`)。

### 规则顺序

| # | 规则名称 | 匹配 | 编码 | 解码 | 策略 |
|---|---|---|---|---|---|
| 1 | `null-undefined` | `v === null \|\| v === undefined` | 直通 | 直通 | passthrough |
| 2 | `primitives` | `boolean \| number \| string` | 直通 | 直通 | passthrough |
| 3 | `circular` | `{ __type: 'circular' }` | -- | 返回 `undefined` | serialize |
| 4 | `serialized-function` | `{ __type: 'function', __fnId }` | -- | 创建可调用代理 | proxy |
| 5 | `function` | `typeof v === 'function'` | 在 CallbackRegistry 中注册,返回 `{ __type, __fnId, __name, __sourceFile, __sourceLine }` | -- | proxy |
| 6 | `serialized-promise` | `{ __type: 'promise', __promiseId }` | -- | 通过 `createPendingPromise` 创建待定 Promise | proxy |
| 7 | `promise` | `v instanceof Promise` | 通过 `registerPromise` 注册,返回 `{ __type: 'promise', __promiseId }` | -- | proxy |
| 8 | `date` | `v instanceof Date` 或 `{ __type: 'date' }` | `{ __type: 'date', __value: isoString }` | `new Date(__value)` | serialize |
| 9 | `regexp` | `v instanceof RegExp` 或 `{ __type: 'regexp' }` | `{ __type: 'regexp', __source, __flags }` | `new RegExp(__source, __flags)` | serialize |
| 10 | `error` | `v instanceof Error` 或 `{ __type: 'error' }` | `{ __type: 'error', __name, __message, __stack }` | 带有 name 和 stack 的 `new Error(__message)` | serialize |
| 11 | `map` | `v instanceof Map` 或 `{ __type: 'map' }` | `{ __type: 'map', __entries: [[k,v]...] }`(递归) | `new Map(decoded entries)` | serialize |
| 12 | `set` | `v instanceof Set` 或 `{ __type: 'set' }` | `{ __type: 'set', __values: [...] }`(递归) | `new Set(decoded values)` | serialize |
| 13 | `typedarray` | `ArrayBuffer.isView(v) && !(DataView)` 或 `{ __type: 'typedarray' }` | `{ __type: 'typedarray', __ctor, __data, __bigint? }` | 使用命名构造器重建 | serialize |
| 14 | `arraybuffer` | `v instanceof ArrayBuffer` 或 `{ __type: 'arraybuffer' }` | `{ __type: 'arraybuffer', __data: [...bytes] }` | `new Uint8Array(__data).buffer` | serialize |
| 15 | `array` | `Array.isArray(v)` | 递归映射 | 保留引用的解码 | serialize |
| 16 | `toJSON` | 具有 `toJSON()` 方法的对象(不是 Date/RegExp/Error/Map/Set) | 调用 `toJSON()` 然后递归编码 | -- | serialize |
| 17 | `object` | `typeof v === 'object' && v !== null` | 递归编码条目 | 保留引用的解码 | serialize |

**保留引用的解码:** 对于数组和普通对象,只有在至少一个子值发生变化时,解码才会创建新引用。这对于 React 协调至关重要 -- 未更改的样式对象保持相同的引用,避免不必要的重新渲染。

**循环引用处理:** 编码器(通过 `createEncoder`)使用 `WeakSet` 跟踪访问过的对象。当检测到循环时,它发出 `{ __type: 'circular' }` 而不是无限递归。解码器将其转换回 `undefined`。

## CallbackRegistry

`CallbackRegistry` 管理活动 JavaScript 函数与其字符串标识符(`fnId`)之间的映射。

### fnId 格式

```
fn_<instanceId>_<counter>
```

- `instanceId` -- 5 字符的随机 base-36 字符串,每个 `CallbackRegistry` 实例唯一
- `counter` -- 自动递增的整数

示例: `fn_a3x9k_42`

### 引用计数

每个注册的函数都以引用计数 1 开始。host 可以:
- `retain(fnId)` -- 增加计数(例如,当属性被复制时)
- `release(fnId)` -- 减少计数;当它达到 0 时,函数从映射中删除

这可以防止陈旧回调造成的内存泄漏。当 Receiver 处理 `DELETE` 操作时,它会释放与已删除节点关联的所有 `fnId`。

### Guest 环境共享

在 guest 沙箱中,`CallbackRegistry` 检测 `globalThis.__RILL_GUEST_ENV__ === true` 并直接共享 `globalThis.__rill.callbacks` Map。这确保了 reconciler 注册的函数可以被 `__rill.invokeCallback` 访问,而不会出现跨模块协调问题。

导出全局单例(`globalCallbackRegistry`)并安装在 `globalThis.__rillGlobalCallbackRegistry` 上,以确保所有打包模块之间有单个实例。

### 方法

| 方法 | 描述 |
|---|---|
| `register(fn)` | 注册一个函数,返回 `fnId` |
| `retain(fnId)` | 增加引用计数 |
| `release(fnId)` | 减少引用计数,在零时删除 |
| `invoke(fnId, args)` | 查找并调用函数 |
| `has(fnId)` | 检查 fnId 是否已注册 |
| `clear()` | 删除所有注册 |
| `getMap()` | 访问内部 Map(用于 `globalThis.__rill.callbacks` 同步) |
| `size` | 已注册函数的数量 |

## bridge.ts: 双向通信

`Bridge` 协调所有跨边界通信。每个 `Engine` 实例化一次,并连接到 guest 沙箱和 host Receiver。

### 配置

```typescript
new Bridge({
  callbackRegistry,     // Engine 的 CallbackRegistry 实例
  guestInvoker,         // (fnId, args) => 在沙箱中调用回调
  guestReleaseCallback, // (fnId) => 在沙箱中释放回调
  onGuestOperations,         // (batch: OperationBatch) => 应用到 Receiver
  onHostMessage,        // (message: HostMessage) => 传递到沙箱
  debug, logger,
});
```

### Guest 到 Host 流程

```
Guest __rill_sendBatch(batch)
  -> Bridge.sendRawBatch(batch)
  -> 通过 TypeRules 解码序列化的属性(函数变为可调用代理)
  -> 提取 fnIds 用于 Receiver 跟踪(_fnIds 注释)
  -> onGuestOperations(decodedBatch)
  -> Receiver.applyBatch
```

### Host 到 Guest 流程

```
Engine.sendToSandbox(message)
  -> Bridge.sendToGuest(message)
  -> 通过 TypeRules 编码参数(函数变为 { __type: 'function', __fnId })
  -> onHostMessage(encodedMessage)
  -> context.inject + evalCode
  -> Guest __rill_handleMessage
```

### 传输模式

Bridge 支持三种操作批次的编码模式:
1. **JSON 模式** -- 默认。操作通过 TypeRules 序列化为 JSON 安全对象。
2. **序列化对象模式** -- 操作已由 guest 编码器预序列化。
3. **二进制模式** -- 操作使用二进制指令协议(P3)编码为 `ArrayBuffer`。

## PromiseManager

管理跨越沙箱边界的 promise 的生命周期。

当 guest 函数返回 `Promise` 时,它会用 `promiseId` 注册。当 promise 结算时,会向另一侧发送 `PROMISE_RESOLVE` 或 `PROMISE_REJECT` 消息,在那里解决或拒绝待定的 promise(由 `createPendingPromise` 创建)。

管理器自动清理超时的 promise,并在 `Bridge.destroy()` 时完全清除,以防止悬空处理程序。

## Remote Ref 协议

Guest 代码可以调用 host 组件实例上的方法(例如 `ref.current.focus()`):

1. Guest 发送 `REF_CALL` 操作: `{ op: 'REF_CALL', refId, method, args, callId }`
2. Receiver 在其 `refMap` 中找到 `refId` 的 React ref
3. Receiver 在 ref 的 `current` 值上调用方法
4. 结果作为 `REF_METHOD_RESULT` 消息发送回去: `{ type: 'REF_METHOD_RESULT', refId, callId, result?, error? }`
5. Guest 解决或拒绝与 `callId` 关联的 promise

`callId` 是一个唯一的字符串,将请求与其响应关联起来,允许多个并发的 ref 调用。
