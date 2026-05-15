# 修复：Android 上 Host→Guest 消息不通
****
## 日期

2026-05-15

## 问题描述

Android 上 Host 发消息给 Guest 完全不通，iOS 正常。表现为：
- Guest 通过 `useEventBridge` 发起请求（如 GET_APP_INFO），Host 收到并处理后调用 `engine.sendEvent()` 发送响应
- 响应事件经过 Bridge 编解码、guestReceiver 到达沙箱，但 Guest 的 `useHostEvent` 回调从未触发
- Promise 的 `.then()` 永远不会执行，导致 UI 不更新

## 根因

两个问题叠加导致：

### 问题1：QuickJS JSI 的 `getGlobal` 返回的函数引用无法从 Host 侧直接调用

`context.getGlobal('__handleHostEvent')` 返回的函数，typeof 是 `'function'`，调用不报错，但函数体**完全不执行**。

原因：QuickJS JSI 绑定层通过 `HostObject` 暴露 `getGlobal` 方法，它把沙箱内的函数包装成 JSI `Function` 返回给 Host 侧。但这个 JSI Function 只是壳，调用时不会切回 QuickJS 沙箱上下文执行原始函数体。JSC 没有这个问题。

额外问题：`globals-setup.ts` 会覆盖 `__handleHostEvent`，其内部使用空的 `__hostEventListeners`，而 SDK 通过 `__rillUseHostEvent` 注册的回调在 `__rillHostEventListeners` 中。必须调用 `__rillHandleHostEvent`（injectRuntimeAPI 版本）才能找到回调。

### 问题2：QuickJS 的 `context.eval()` 不自动执行 pending 微任务

通过 `context.eval()` 成功调用 `__rillHandleHostEvent` 后，回调执行了，`Promise.resolve()` 也被调用了，但 `.then()` 回调永远不触发。

原因：QuickJS 的 `JS_Eval()` 执行完代码后不会自动执行排队的微任务（Promise 的 `.then` 回调）。JSC 会自动处理，所以 iOS 没问题。QuickJS 需要显式调用 `JS_ExecutePendingJob()` 来 drain 微任务队列。

## 解决方案

### 修复1：`dispatchMessageToGuest` 中改用 `context.eval()` 调用沙箱函数

文件：`src/host/Engine.ts`

HOST_EVENT 和 CALL_FUNCTION 分支，从 `getGlobal` + 直接调用改为 `context.eval()` + JSON 字面量传参：

```js
// 之前（不工作）
const fn = context.getGlobal('__handleHostEvent');
fn(eventName, payload);

// 之后（工作）
context.eval(`globalThis.__rillHandleHostEvent("${eventName}", ${payloadJson})`);
```

关键点：
- 使用 `__rillHandleHostEvent` 而非 `__handleHostEvent`
- payload 通过 `JSON.stringify` 嵌入 eval 字符串，因为 `setGlobal` 设置的对象作为参数传给沙箱内函数时也有问题

### 修复1a：`injectRuntimeAPI` 注入独立事件总线

文件：`src/host/Engine.ts`

新增 `__rillUseHostEvent` / `__rillHandleHostEvent` / `__rillHostEventListeners`，与 globals-setup.ts 的 `__useHostEvent` / `__handleHostEvent` / `__hostEventListeners` 分离。

原因：globals-setup.ts 在 Guest bundle 中执行，会覆盖 `__handleHostEvent`，其内部使用独立的 `__hostEventListeners` Map（此时为空）。SDK 注册回调走的是 injectRuntimeAPI 注入的 `__rillUseHostEvent`，回调存在 `__rillHostEventListeners` 中。如果 Engine 调用的是被覆盖后的 `__handleHostEvent`，会在空的 `__hostEventListeners` 中查找，找不到任何回调。

### 修复1b：`sdk.ts` 优先使用 `__rillUseHostEvent` 注册回调

文件：`src/guest/let/sdk.ts`

`useHostEvent` 和 `useRemoteRef` 中，从直接取 `__useHostEvent` 改为优先取 `__rillUseHostEvent`，fallback 到 `__useHostEvent`：

```js
// 之前
if ('__useHostEvent' in globalThis) {
  const unsubscribe = g.__useHostEvent(eventName, stableCallback);
}

// 之后
const subscribe = g.__rillUseHostEvent ?? g.__useHostEvent;
if (typeof subscribe === 'function') {
  const unsubscribe = subscribe(eventName, stableCallback);
}
```

原因：虽然 injectRuntimeAPI 会执行 `globalThis.__useHostEvent = globalThis.__rillUseHostEvent` 覆盖旧版本，但在 QuickJS 的 eval 执行时序下，`__useHostEvent` 可能仍指向 globals-setup.ts 的旧版本（使用空的 `__hostEventListeners`）。优先取 `__rillUseHostEvent` 确保回调注册到 `__rillHostEventListeners`，与 Engine.ts eval 调用的 `__rillHandleHostEvent` 对齐。

### 修复2：C++ 层 `eval()` 后自动 drain 微任务

文件：`native/quickjs/src/QuickJSSandboxJSI.cpp`

在 `JS_Eval()` 之后加上微任务 drain 循环：

```cpp
JSContext *ctx;
int execCount = 0;
while (JS_ExecutePendingJob(qjsRuntime_, &ctx) > 0) {
  execCount++;
  if (execCount > 1000) break; // 安全阀
}
```

## 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `src/host/Engine.ts` | 1. `dispatchMessageToGuest` 的 HOST_EVENT/CALL_FUNCTION 分支改用 `context.eval()` + JSON 字面量 |
| | 2. `injectRuntimeAPI` 注入 `__rillUseHostEvent` / `__rillHandleHostEvent` 独立事件总线 |
| `src/guest/let/sdk.ts` | `useHostEvent` / `useRemoteRef` 优先使用 `__rillUseHostEvent` 注册回调 |
| `native/quickjs/src/QuickJSSandboxJSI.cpp` | `eval()` 方法后加 `JS_ExecutePendingJob` 循环 |
