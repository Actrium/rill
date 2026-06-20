# CDP 调试协议

Rill 实现了 Chrome DevTools 协议(CDP)服务器,使开发者能够连接 Chrome DevTools 或 VS Code 来检查和调试 guest 沙箱。每个租户都作为单独的可调试目标公开。

## CDPServer 架构

**文件:** `native/core/src/devtools/CDPServer.h`

```
Chrome DevTools / VS Code
       |
       |  WebSocket (ws://localhost:9229)
       v
+---------------------------------------+
|  CDPServer                            |
|  +-- WebSocket Transport(可插拔)      |
|  +-- Protocol Router                  |
|  +-- Session Manager                  |
+---------------------------------------+
|  Domain Adapters                      |
|  +-- ConsoleAdapter                   |
|  +-- RuntimeAdapter                   |
|  +-- DOMAdapter                       |
|  +-- DebuggerAdapter                  |
|  +-- NetworkAdapter                   |
+---------------------------------------+
```

### 组件

**CDPServer** -- 主服务器类。管理 WebSocket 侦听器,将 CDP JSON-RPC 消息路由到域适配器,并维护会话状态。所有公共方法都是线程安全的。

**CDPTransport** -- WebSocket 层的抽象接口。平台特定的实现通过 `CDPServerConfig::transport` 插入。当 transport 为 nullptr 时使用无操作存根(单元测试)。

**Protocol Router** -- 解析传入的 JSON-RPC 消息,提取 CDP 域和方法(例如 `Runtime.evaluate`),并分派到适当的处理程序。

**Session Manager** -- 维护每个连接的会话状态,跟踪启用了哪些 CDP 域以及会话附加到哪个租户。

### 配置

```cpp
struct CDPServerConfig {
  uint16_t port = 9229;
  std::string host = "127.0.0.1";
  bool enabled = true;
  size_t maxConnections = 10;
  uint32_t pingIntervalMs = 30000;

  EvaluateCallback onEvaluate;
  GetComponentTreeCallback onGetComponentTree;
  std::shared_ptr<CDPTransport> transport;
};
```

## 目标发现

CDPServer 实现 `/json` HTTP 端点用于目标发现。Chrome DevTools(`chrome://inspect`)轮询此端点以查找可调试目标。

### /json 响应

```json
[
  {
    "id": "42",
    "type": "node",
    "title": "Rill Guest: MyApp",
    "url": "rill://tenant/42",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9229/tenant/42",
    "devtoolsFrontendUrl": "devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9229/tenant/42"
  }
]
```

每个注册的租户都作为单独的目标出现。目标在租户创建和销毁时注册/注销。

### 连接

1. 在 Chrome 中打开 `chrome://inspect`
2. Rill 目标出现在"Remote Target"下
3. 点击"inspect"打开连接到特定租户的 DevTools
4. 或者,将 VS Code 的 JavaScript 调试器连接到 `ws://localhost:9229/tenant/<id>`

## 域适配器

域适配器在 CDP 协议方法和 Rill 的内部状态之间进行转换。

### Console Domain

**文件:** `native/core/src/devtools/ConsoleAdapter.h`

将 guest console 输出映射到 CDP Console/Runtime 事件。

| CDP 事件 | 来源 |
|---|---|
| `Runtime.consoleAPICalled` | Guest `console.log/warn/error` 调用 |

通过 `Console.enable` 或 `Runtime.enable` 启用。

### Runtime Domain

**文件:** `native/core/src/devtools/RuntimeAdapter.h`

在 guest 上下文中提供 JavaScript 评估和对象检查。

| CDP 方法 | 实现 |
|---|---|
| `Runtime.evaluate` | 通过回调调用 `evalInTenant(tenantId, expression)` |
| `Runtime.getProperties` | 枚举 guest 中的对象属性 |
| `Runtime.enable` | 开始发送 console 和异常事件 |
| `Runtime.disable` | 停止事件 |

| CDP 事件 | 来源 |
|---|---|
| `Runtime.consoleAPICalled` | Guest console 调用 |
| `Runtime.exceptionThrown` | Guest 中未捕获的异常 |

### DOM Domain

**文件:** `native/core/src/devtools/DOMAdapter.h`

将 Receiver 的组件树映射到 CDP DOM 节点。

| CDP 方法 | 实现 |
|---|---|
| `DOM.getDocument` | 从 `getComponentTree()` 返回根节点 |
| `DOM.requestChildNodes` | 返回特定节点的子节点 |
| `DOM.getAttributes` | 将节点属性作为属性对返回 |

适配器在 Rill 的 `nodeMap` 结构(整数 ID、组件类型字符串、属性对象)和 CDP 的 DOM 节点模型(nodeId、nodeName、属性数组)之间进行转换。

### Debugger Domain

**文件:** `native/core/src/devtools/DebuggerAdapter.h`

提供断点和单步支持。实现因沙箱引擎而异:

| 引擎 | 调试器支持 |
|---|---|
| JavaScriptCore | `JSGlobalContextSetInspectable` + 原生检查器协议 |
| Hermes | 原生 CDP 支持(Hermes 有内置 CDP) |
| QuickJS | 自定义断点实现 |

| CDP 方法 | 实现 |
|---|---|
| `Debugger.enable` | 为租户的运行时激活调试器 |
| `Debugger.setBreakpointByUrl` | 在 guest 代码中设置断点 |
| `Debugger.resume` | 恢复执行 |
| `Debugger.stepOver/stepInto/stepOut` | 单步控制 |
| `Debugger.pause` | 暂停执行 |

### Network Domain

**文件:** `native/core/src/devtools/NetworkAdapter.h`

将 `NetworkSandbox` 审计日志中的网络活动作为 CDP Network 事件公开。

| CDP 事件 | 来源 |
|---|---|
| `Network.requestWillBeSent` | Guest 发起网络请求 |
| `Network.responseReceived` | 接收到响应 |
| `Network.loadingFinished` | 请求完成 |
| `Network.loadingFailed` | 请求失败或被阻止 |

`NetworkSandbox` 中的审计环形缓冲区提供底层数据。

### Profiler Domain

来自 `DiagnosticsCollector` 的 CPU 分析数据可以通过 Profiler 域公开,为 guest 代码执行提供性能洞察。

## 多租户会话

### 会话模型

每个 WebSocket 连接创建一个 `CDPSession`:

```cpp
struct CDPSession {
  SessionId id;                // 唯一会话标识符
  TenantId tenantId;           // 附加的租户(0 表示未附加)
  ConnectionId connectionId;   // WebSocket 连接

  bool consoleEnabled;
  bool runtimeEnabled;
  bool debuggerEnabled;
  bool domEnabled;
  bool networkEnabled;
  bool profilerEnabled;

  uint64_t createdAt;
  uint64_t lastActivityAt;
};
```

会话是隔离的: 在一个会话上启用 Debugger 域不会影响其他会话。事件仅路由到附加到相关租户的会话。

### 会话生命周期

1. DevTools 通过 WebSocket 连接
2. CDPServer 创建一个 `Connection` 记录
3. 第一个带有 `sessionId` 或租户路径的 CDP 消息创建一个 `CDPSession`
4. 域启用/禁用方法切换每个会话的标志
5. 事件仅发送到启用了相关域的会话
6. 断开连接会删除会话和连接记录

## 传输层

### CDPTransport 接口

```cpp
class CDPTransport {
public:
  virtual bool start(const std::string& host, uint16_t port) = 0;
  virtual void stop() = 0;
  virtual void send(ConnectionId connId, const std::string& message) = 0;
  virtual void close(ConnectionId connId) = 0;

  void setOnMessage(OnMessageCallback cb);
  void setOnConnect(OnConnectCallback cb);
  void setOnDisconnect(OnDisconnectCallback cb);
};
```

### Apple Transport

**文件:** `native/core/src/devtools/CDPTransportApple.h/.mm`

使用 Apple 的 `Network.framework` 作为 WebSocket 服务器:
- `nw_listener_t` 用于传入连接
- `nw_connection_t` 用于每个客户端的 WebSocket 通信
- 在专用调度队列上运行

### 其他平台

`CDPTransport` 接口设计为可插拔。未来的实现可以使用:
- Android: OkHttp WebSocket 服务器
- Web: 原生 WebSocket API
- 跨平台: Boost.Beast 或 libwebsockets

## CDP 消息格式

### 请求(DevTools 到服务器)

```json
{
  "id": 1,
  "method": "Runtime.evaluate",
  "params": { "expression": "1 + 1", "returnByValue": true },
  "sessionId": "tenant-42-session-1"
}
```

### 响应(服务器到 DevTools)

```json
{
  "id": 1,
  "result": { "result": { "type": "number", "value": 2 } }
}
```

### 错误响应

```json
{
  "id": 1,
  "error": { "code": -32601, "message": "Method not found" }
}
```

### 事件(服务器到 DevTools,主动)

```json
{
  "method": "Runtime.consoleAPICalled",
  "params": {
    "type": "log",
    "args": [{ "type": "string", "value": "Hello from guest" }],
    "timestamp": 1706640000000
  },
  "sessionId": "tenant-42-session-1"
}
```

## 错误代码

| 代码 | 名称 | 描述 |
|---|---|---|
| -32700 | PARSE_ERROR | 无效的 JSON |
| -32600 | INVALID_REQUEST | 缺少必需字段 |
| -32601 | METHOD_NOT_FOUND | 未知的 CDP 方法 |
| -32602 | INVALID_PARAMS | 无效的方法参数 |
| -32603 | INTERNAL_ERROR | 服务器端错误 |
| -32001 | SESSION_NOT_FOUND | 会话 ID 未识别 |
| -32002 | TARGET_NOT_FOUND | 租户未注册 |
| -32003 | TENANT_NOT_AVAILABLE | 租户暂停或销毁 |

## 统计信息

CDPServer 跟踪:
- `getConnectionCount()` -- 活动的 WebSocket 连接
- `getSessionCount()` -- 活动的 CDP 会话
- `getMessagesReceived()` -- 总入站消息
- `getMessagesSent()` -- 总出站消息
