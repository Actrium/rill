# CDP Debugging Protocol

Rill implements a Chrome DevTools Protocol (CDP) server that enables developers to connect Chrome DevTools or VS Code to inspect and debug guest sandboxes. Each tenant is exposed as a separate debuggable target.

## CDPServer Architecture

**File:** `native/core/src/devtools/CDPServer.h`

```
Chrome DevTools / VS Code
       |
       |  WebSocket (ws://localhost:9229)
       v
+---------------------------------------+
|  CDPServer                            |
|  +-- WebSocket Transport (pluggable)  |
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

### Components

**CDPServer** -- Main server class. Manages the WebSocket listener, routes CDP JSON-RPC messages to domain adapters, and maintains session state. All public methods are thread-safe.

**CDPTransport** -- Abstract interface for the WebSocket layer. Platform-specific implementations plug in via `CDPServerConfig::transport`. A no-op stub is used when transport is nullptr (unit testing).

**Protocol Router** -- Parses incoming JSON-RPC messages, extracts the CDP domain and method (e.g., `Runtime.evaluate`), and dispatches to the appropriate handler.

**Session Manager** -- Maintains per-connection session state, tracking which CDP domains are enabled and which tenant the session is attached to.

### Configuration

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

## Target Discovery

The CDPServer implements the `/json` HTTP endpoint for target discovery. Chrome DevTools (`chrome://inspect`) polls this endpoint to find debuggable targets — always on exactly the host:port the user configured.

### Port layout (Apple transport)

Network.framework's WebSocket listener auto-upgrades and cannot answer a plain HTTP GET, so `CDPTransportApple` splits the two surfaces across sibling loopback ports:

| Surface | Port |
|---|---|
| `/json` discovery (what `chrome://inspect` probes) | configured port (default 9229) |
| WebSocket (CDP traffic) | configured port + 1 (default 9230) |

Clients never guess the ws port: every `webSocketDebuggerUrl` the server hands out already points at it (`CDPTransport::webSocketPort`). Transports that can serve both on one listener keep everything on the configured port.

### /json Response

```json
[
  {
    "id": "42",
    "type": "node",
    "title": "Rill Guest: MyApp",
    "url": "rill://tenant/42",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9230/tenant/42",
    "devtoolsFrontendUrl": "devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9230/tenant/42"
  }
]
```

Each registered tenant appears as a separate target. Targets are registered/unregistered as tenants are created and destroyed.

### Connecting

1. Open `chrome://inspect` in Chrome and add `127.0.0.1:9229` (the configured port) under "Discover network targets"
2. Rill targets appear under "Remote Target"
3. Click "inspect" to open DevTools connected to a specific tenant
4. Alternatively, connect VS Code's JavaScript debugger to the `webSocketDebuggerUrl` reported by `http://127.0.0.1:9229/json` (on the Apple transport: `ws://localhost:9230/tenant/<id>`)

## Domain Adapters

Domain adapters translate between CDP protocol methods and Rill's internal state.

### Console Domain

**File:** `native/core/src/devtools/ConsoleAdapter.h`

Maps guest console output to CDP Console/Runtime events.

| CDP Event | Source |
|---|---|
| `Runtime.consoleAPICalled` | Guest `console.log/warn/error` calls |

Enabled by `Console.enable` or `Runtime.enable`.

### Runtime Domain

**File:** `native/core/src/devtools/RuntimeAdapter.h`

Provides JavaScript evaluation and object inspection in the guest context.

| CDP Method | Implementation |
|---|---|
| `Runtime.evaluate` | Calls `evalInTenant(tenantId, expression)` via callback |
| `Runtime.getProperties` | Enumerates object properties in guest |
| `Runtime.enable` | Starts sending console and exception events |
| `Runtime.disable` | Stops events |

| CDP Event | Source |
|---|---|
| `Runtime.consoleAPICalled` | Guest console calls |
| `Runtime.exceptionThrown` | Uncaught exceptions in guest |

### DOM Domain

**File:** `native/core/src/devtools/DOMAdapter.h`

Maps the Receiver's component tree to CDP DOM nodes.

| CDP Method | Implementation |
|---|---|
| `DOM.getDocument` | Returns root node from `getComponentTree()` |
| `DOM.requestChildNodes` | Returns children of a specific node |
| `DOM.getAttributes` | Returns node props as attribute pairs |

The adapter translates between Rill's `nodeMap` structure (integer IDs, component type strings, props objects) and CDP's DOM node model (nodeId, nodeName, attributes array).

### Debugger Domain

**File:** `native/core/src/devtools/DebuggerAdapter.h`

Provides breakpoint and stepping support. Implementation varies by sandbox engine:

| Engine | Debugger Support |
|---|---|
| JavaScriptCore | `JSGlobalContextSetInspectable` + native inspector protocol |
| Hermes | Native CDP support (Hermes has built-in CDP) |
| QuickJS | Custom breakpoint implementation |

| CDP Method | Implementation |
|---|---|
| `Debugger.enable` | Activates debugger for the tenant's runtime |
| `Debugger.setBreakpointByUrl` | Sets breakpoint in guest code |
| `Debugger.resume` | Resumes execution |
| `Debugger.stepOver/stepInto/stepOut` | Step controls |
| `Debugger.pause` | Pauses execution |

### Network Domain

**File:** `native/core/src/devtools/NetworkAdapter.h`

Exposes network activity from `NetworkSandbox` audit logs as CDP Network events.

| CDP Event | Source |
|---|---|
| `Network.requestWillBeSent` | Guest initiates network request |
| `Network.responseReceived` | Response received |
| `Network.loadingFinished` | Request completed |
| `Network.loadingFailed` | Request failed or blocked |

The audit ring buffer in `NetworkSandbox` provides the underlying data.

### Profiler Domain

CPU profiling data from `DiagnosticsCollector` can be exposed through the Profiler domain, providing performance insights for guest code execution.

## Multi-Tenant Sessions

### Session Model

Each WebSocket connection creates a `CDPSession`:

```cpp
struct CDPSession {
  SessionId id;                // Unique session identifier
  TenantId tenantId;           // Attached tenant (0 if unattached)
  ConnectionId connectionId;   // WebSocket connection

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

Sessions are isolated: enabling the Debugger domain on one session does not affect other sessions. Events are routed only to sessions attached to the relevant tenant.

### Session Lifecycle

1. DevTools connects via WebSocket
2. CDPServer creates a `Connection` record
3. First CDP message with a `sessionId` or tenant path creates a `CDPSession`
4. Domain enable/disable methods toggle per-session flags
5. Events are sent only to sessions with the relevant domain enabled
6. Disconnect removes the session and connection records

## Transport Layer

### CDPTransport Interface

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

**File:** `native/core/src/devtools/CDPTransportApple.h/.mm`

Uses Apple's `Network.framework` for the WebSocket server:
- `nw_listener_t` for incoming connections
- `nw_connection_t` for per-client WebSocket communication
- Runs on a dedicated dispatch queue

### Other Platforms

The `CDPTransport` interface is designed to be pluggable. Future implementations can use:
- Android: OkHttp WebSocket server
- Web: Native WebSocket API
- Cross-platform: Boost.Beast or libwebsockets

## CDP Message Format

### Request (DevTools to Server)

```json
{
  "id": 1,
  "method": "Runtime.evaluate",
  "params": { "expression": "1 + 1", "returnByValue": true },
  "sessionId": "tenant-42-session-1"
}
```

### Response (Server to DevTools)

```json
{
  "id": 1,
  "result": { "result": { "type": "number", "value": 2 } }
}
```

### Error Response

```json
{
  "id": 1,
  "error": { "code": -32601, "message": "Method not found" }
}
```

### Event (Server to DevTools, unsolicited)

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

## Error Codes

| Code | Name | Description |
|---|---|---|
| -32700 | PARSE_ERROR | Invalid JSON |
| -32600 | INVALID_REQUEST | Missing required fields |
| -32601 | METHOD_NOT_FOUND | Unknown CDP method |
| -32602 | INVALID_PARAMS | Invalid method parameters |
| -32603 | INTERNAL_ERROR | Server-side error |
| -32001 | SESSION_NOT_FOUND | Session ID not recognized |
| -32002 | TARGET_NOT_FOUND | Tenant not registered |
| -32003 | TENANT_NOT_AVAILABLE | Tenant paused or destroyed |

## Statistics

The CDPServer tracks:
- `getConnectionCount()` -- Active WebSocket connections
- `getSessionCount()` -- Active CDP sessions
- `getMessagesReceived()` -- Total inbound messages
- `getMessagesSent()` -- Total outbound messages
