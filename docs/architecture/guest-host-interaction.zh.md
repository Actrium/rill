# 渲染管道与通信协议

本文档描述了 guest 沙箱和 host 运行时如何通信、从 JSX 到原生组件的完整渲染管道,以及连接它们的消息协议。

## 角色和边界

| 角色 | 位置 | 职责 |
|---|---|---|
| **Host App** | React Native 进程 | 创建 `Engine`,通过 `ComponentRegistry` 注册组件,挂载 `EngineView` |
| **Engine** | `src/host/engine/engine.ts` | 管理沙箱生命周期,注入全局变量,拥有 `Bridge` 和 `CallbackRegistry` |
| **Bridge** | `src/shared/bridge/bridge.ts` | 双向编码/解码,路由操作和消息 |
| **Receiver** | `src/host/receiver/receiver.ts` | 应用操作批次,维护 `nodeMap`,生成 React 元素树 |
| **Reconciler** | `src/guest/runtime/reconciler/` | 自定义 `react-reconciler` host config,将 React 树变化转换为操作 |
| **Guest Runtime** | 沙箱 JS 引擎 | 执行 guest bundle,管理 hooks 状态,运行回调 |

沙箱边界是关键的信任边界。所有跨越它的数据都通过 `Bridge` 和 `type-rules.ts` 进行编码和清理。

## 通信通道

### Guest 到 Host: `__rill_sendBatch(batch)`

高频通道。reconciler 将单个 React commit 阶段的所有变更批量处理为一个 `OperationBatch` 并调用 `__rill_sendBatch`。Bridge 编码批次(函数变为 `{ __type: 'function', __fnId }`,复杂类型通过 TypeRules 序列化)并将其传递给 `Receiver.applyBatch`。

```
Guest Reconciler -> __rill_sendBatch(batch) -> Bridge.sendRawBatch -> onGuestOperations -> Receiver.applyBatch
```

### Host 到 Guest: `sendToSandbox(message)`

较低频率的通道,用于回调调用、host 事件、配置更新和拆除。参数在跨越边界之前会被清理以确保 JSON 安全。

```
Engine.sendToSandbox -> Bridge.sendToGuest -> context.inject + evalCode -> Guest __rill_handleMessage
```

## 渲染管道

### 1. JSX 到虚拟节点

Guest 代码编写标准的 React JSX:

```jsx
const App = () => <View style={{ flex: 1 }}><Text>Hello</Text></View>;
```

预打包的 React shim 提供 `createElement`。自定义 reconciler host config (`host-config.ts`) 实现:

- `createInstance(type, props)` -- 创建一个带有唯一数字 ID、序列化属性(函数被 fnId 标记替换)和组件类型字符串的 `VNode`。
- `createTextInstance(text)` -- 创建一个 `__TEXT__` VNode。
- `appendChild(parent, child)` -- 记录一个 `APPEND` 操作。
- `insertBefore(parent, child, before)` -- 记录一个 `INSERT` 操作。
- `removeChild(parent, child)` -- 记录 `REMOVE` + `DELETE` 操作。

### 2. 操作收集和刷新

在 commit 阶段,`OperationCollector` 累积所有操作。在 commit 结束时(`resetAfterCommit`),收集器刷新批次:

```typescript
const batch: OperationBatch = {
  version: 1,
  batchId: nextBatchId++,
  operations: [...collected],
};
__rill_sendBatch(batch);
```

### 3. Bridge 编码

`Bridge.sendRawBatch` 使用 `TypeRules` 编码批次:

- 属性中的函数变为 `{ __type: 'function', __fnId, __name, __sourceFile, __sourceLine }`
- 复杂类型(Date、RegExp、Map、Set、Error)被序列化为 JSON 安全的表示
- 循环引用变为 `{ __type: 'circular' }`

编码后的批次被传递给 `onGuestOperations` 回调。

### 4. Receiver 处理

`Receiver.applyBatch` 遍历操作并更新其内部的 `nodeMap`:

- `CREATE` -- 向 `nodeMap` 添加新的 `NodeInstance`
- `UPDATE` -- 合并新属性,释放旧的函数引用
- `APPEND` / `INSERT` -- 更新父子关系(使用 O(1) 的基于 Set 的查找)
- `REMOVE` / `DELETE` -- 分离并递归清理节点
- `REORDER` -- 替换子元素数组
- `TEXT` -- 更新文本内容
- `REF_CALL` -- 向 host 组件 ref 分派方法调用

处理后,`scheduleUpdate` 触发一个微任务,调用 `onUpdate`,这会导致 `EngineView` 重新渲染。

### 5. 渲染到原生组件

`Receiver.render()` 从 `rootChildren` 开始遍历树:

```typescript
renderNode(id) {
  const node = nodeMap.get(id);
  const Component = registry.get(node.type);  // 白名单查找
  const children = node.children.map(renderNode);
  return React.createElement(Component, { ...node.props, key, ref }, ...children);
}
```

属性已经被 Bridge 解码 -- 函数是可调用的代理闭包,通过 `CALL_FUNCTION` 消息路由回去。

## 更新流程

当 guest 状态变化时:

```
Guest setState
  -> React 调度更新
  -> Reconciler 重新渲染(与之前的 VNode 树进行 diff)
  -> 只有变化的节点产生操作(增量 CREATE/UPDATE/REMOVE)
  -> OperationCollector 刷新增量批次
  -> Receiver 应用增量 diff 到 nodeMap
  -> React 元素树反映最小变化
  -> 原生 UI 更新
```

## 回调流程

当 host 渲染的组件触发事件时(例如 `onPress`):

```
1. 原生 onPress 触发
2. Receiver 渲染的元素有一个代理函数(来自 Bridge 解码)
3. 代理调用 Bridge.invokeFunction(fnId, encodedArgs)
4. Bridge 路由到 guestInvoker:
   - 在沙箱上下文中查找 __rill.invokeCallback
   - 调用 __rill.invokeCallback(fnId, args)
5. Guest CallbackRegistry 找到原始函数
6. Guest 函数执行(可能调用 setState)
7. 重新渲染产生新操作
8. Receiver 应用更新
```

流回 guest 的参数通过 `TypeRules` 编码,以处理复杂的事件对象(例如带有 `preventDefault` 等函数的 `GestureResponderEvent`)。

## 操作类型

| 操作 | 方向 | 字段 | 描述 |
|---|---|---|---|
| `CREATE` | Guest -> Host | `id, type, props` | 创建新的虚拟节点 |
| `UPDATE` | Guest -> Host | `id, props, removedProps` | 更新节点属性 |
| `DELETE` | Guest -> Host | `id` | 删除节点及其所有后代 |
| `APPEND` | Guest -> Host | `id, parentId, childId` | 将子元素追加到父元素 |
| `INSERT` | Guest -> Host | `id, parentId, childId, index` | 在指定位置插入子元素 |
| `REMOVE` | Guest -> Host | `id, parentId, childId` | 从父元素中移除子元素 |
| `REORDER` | Guest -> Host | `id, parentId, childIds` | 重新排序子元素 |
| `TEXT` | Guest -> Host | `id, text` | 更新文本内容 |
| `REF_CALL` | Guest -> Host | `id, refId, method, args, callId` | 调用 host 组件 ref 上的方法 |

## Host 消息类型

| 消息 | 方向 | 字段 | 描述 |
|---|---|---|---|
| `CALL_FUNCTION` | Host -> Guest | `fnId, args` | 调用已注册的 guest 回调 |
| `HOST_EVENT` | Host -> Guest | `eventName, payload` | 向 guest 监听器传递命名事件 |
| `CONFIG_UPDATE` | Host -> Guest | `config` | 更新 guest 配置 |
| `DESTROY` | Host -> Guest | (无) | 通知沙箱拆除 |
| `REF_METHOD_RESULT` | Host -> Guest | `refId, callId, result?, error?` | 从 REF_CALL 返回值 |
| `PROMISE_RESOLVE` | Host -> Guest | `promiseId, value` | 解决跨边界 promise |
| `PROMISE_REJECT` | Host -> Guest | `promiseId, error` | 拒绝跨边界 promise |
