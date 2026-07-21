# QuickJS CDP 调试器：真前端联调工具

这三个文件把 rill 的 QuickJS CDP 调试栈（生产代码
`AdapterDebugTarget → DebuggerAdapter → QuickJSEngineDebugger →
QuickJSDebugCore → 打补丁的解释器`）暴露成一个可被真 Chrome DevTools 前端
驱动的目标，用于人肉/自动联调。均为 dev 工具，**不进任何出货构建**。

| 文件 | 作用 |
|------|------|
| `cdp_stdio_host.cpp` | 长驻 CDP 主机：把上面那套生产栈裹在一个 guest 脚本外，CDP JSON 走 stdio 逐行收发。 |
| `cdp_ws_bridge.js` | WebSocket + `/json` 发现桥：真 Chrome 经 `chrome://inspect` 发现目标、开 WS，每帧转到主机 stdin，主机每行 stdout 回成一帧。 |
| `cdp_client_probe.js` | 用 `chrome-remote-interface`（DevTools 前端所用同款 CDP 客户端库）跑一遍完整会话，做协议/传输层自动化验证。 |
| `build-cdp-host.sh` | 编译 `cdp_stdio_host`（`RILL_QJS_DEBUG + RILL_WIP_CDP_DEVTOOLS`，本地 clang）。 |

## 自动化验证（无需浏览器）

```bash
OUT=/tmp/cdp_host bash build-cdp-host.sh
mkdir -p /tmp/cdpbridge && cd /tmp/cdpbridge
npm install ws chrome-remote-interface
cp <此目录>/cdp_ws_bridge.js <此目录>/cdp_client_probe.js .
HOSTBIN=/tmp/cdp_host PORT=9411 node cdp_ws_bridge.js &   # 起桥
PORT=9411 node cdp_client_probe.js                        # 跑探针
```

期望 **12/12 ALL PASS**：executionContextCreated → Runtime.evaluate（空闲态求值
+ 异常呈现）→ scriptParsed → getScriptSource → setBreakpointByUrl（解析出真
scriptId）→ 断点命中（真 `greet → <eval>` 双帧栈）→ evaluateOnCallFrame
`count=1` → Runtime.evaluate（暂停态）→ resume 跑完。Linux 与 macOS(arm64)
均已实测通过。

## Console 支持范围（MVP）

主机在 `Runtime.enable` 时通告执行上下文（DevTools 没看到执行上下文就根本
不会发 Console 输入），并处理 `Runtime.evaluate`：

- **暂停态**：经 `runOnPausedThread` 在被扣住的 runtime 线程上求值（调试钩子
  抑制，不会自暂停）；DevTools 选中帧后的 Console 输入走
  `Debugger.evaluateOnCallFrame`（Debugger 域，原有能力）。
- **空闲态**：投给 guest 线程的任务队列求值；guest 忙/正暂停在断点时 3 秒超时
  回明确错误（避免卡死 stdin 令 resume 无法送达）。
- **结果呈现**：基本类型全保真；对象/函数给描述文本（优先 JSON 序列化），
  **不带 objectId**（引擎的 objectId 注册表是暂停期作用域、resume 时释放，
  Console 结果的可展开性留作后续）。

**仍未覆盖**：`console.log` 转发（`Runtime.consoleAPICalled` 事件）、Console
结果对象展开、`awaitPromise`、命令行 API（`$0`、`copy` 等）。

## 真 Chrome DevTools 联调（人肉一步）

1. 起桥：`HOSTBIN=/tmp/cdp_host PORT=9411 node cdp_ws_bridge.js`
2. Chrome 打开 `chrome://inspect` → **Discover network targets** → **Configure…**
   → 加 `127.0.0.1:9411` → 勾 Discover。
3. 列表里出现 **rill QuickJS guest**，点 **inspect** 开 DevTools。
4. Sources 里能看到 `guest.js`；在第 3 行下断点，点一次 **Configure/触发**
   （或让前端自动 `runIfWaitingForDebugger`）即命中，可看真调用栈、在暂停帧
   里 `globalThis.count` 求值、Resume 继续。

> 每个 WS 连接对应一个 ephemeral 主机进程；DevTools 关闭即桥收尾主机（stdin
> EOF 干净退出，SIGKILL 兜底）。
