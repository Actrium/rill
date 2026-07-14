# rill CDP 调试器 —— 测试清单与手册

覆盖 rill guest 引擎(Hermes / QuickJS)的 CDP(Chrome DevTools Protocol)
调试能力:从纯 C++ 单元测试,到接真 `hermes.framework` 的原生 e2e,再到用真
CDP 客户端库经真 WebSocket 驱动的前端联调,以及真 Chrome DevTools GUI 的人肉
清单。

> **门控与出货**:CDP 调试全部代码门控在编译期宏后,**生产默认不出货**:
> - `RILL_WIP_CDP_DEVTOOLS=1` —— relay 接缝 / DebuggerAdapter / DevTools 服务
> - `RILL_QJS_DEBUG` —— QuickJS 引擎逐行 hook 与调试核心(关闭时宏折叠成
>   no-op,引擎字节不变)
> - `HERMES_ENABLE_DEBUGGER=1` —— Hermes CDPAgent / CDPDebugAPI(pod 也须以此
>   构建,否则运行期为 no-op 桩)
>
> 出货核对见文末「§10 出货零足迹」。

---

## §0 测试矩阵总表

| # | 能力 | 测试套 | 机器 | 期望 | 现状 |
|---|------|--------|------|------|------|
| A | 协议/适配器/服务/接缝 + `/json` 发现端点 + 多 session 路由 + `parseRequestLine` 单元 | `native/core` `make test` | 任意 | 388/388 | ✅ |
| B | QuickJS 引擎:断点/单步/真栈/多租户 | `native/quickjs/test/build-run.sh` | 任意(本地 C) | 26 ALL PASS | ✅ |
| C | QuickJS CDP 全栈(裸 CDP 报文)+ 帧内作用域求值 + 嵌套对象展开 | `native/quickjs/test/build-run-cdp.sh` | 任意 | 39 ALL PASS | ✅ |
| D | Hermes CDP 接真 hermes.framework | `native/hermes/test/build-run.sh` | **s67**(需 destroot) | 7/7 ALL PASS | ✅ |
| E | Hermes watchdog×pause 调和 | `native/hermes/test/build-run-watchdog.sh` | **s67** | 3/3 PASS | ✅ |
| F | 真前端(chrome-remote-interface)经真 WS | `native/quickjs/tools/` 三件套 | Linux + **s67** | 8/8 ALL PASS | ✅ |
| G | QuickJS-asyncify VM 级暂停/恢复 PoC(Milestone A) | `native/quickjs/poc/`(需 emsdk) | 任意(emcc+node) | 3/3 claims PASS | ✅ |
| I | Milestone B 核心:asyncify 调试核心 + **跨 unwind evaluate**(debug wasm) | `native/quickjs/build-wasm-debug.sh` + `test/run-debug-wasm.mjs`(需 emsdk) | 任意(emcc+node) | 11/11 claims PASS | ✅ |
| J | Milestone B web 端:worker `dbg.*` 协议 + TurnGate + CDP 翻译器 + 绕闸路由 + **timer 回调门控**(真 TimerManager)+ `CdpDebugSession`(真 wasm) | `src/host/web/worker/__tests__`(bun) | 任意 | 71/71 PASS | ✅ |
| K | 胖 CDP debug wasm(直接讲原始 CDP,含 `Runtime.getProperties` 路由)+ 反向隧道 relay | `native/quickjs/test/run-cdp-wasm.mjs` + `src/host/web/tools`(bun;web 端 session 测试并入 J 行) | 任意(emcc+node/bun) | 9/9 + 4/4 PASS | ✅ |
| L | **浏览器内 E2E**:无头 Chromium,原始 CDP 客户端 → relay → 页面 → worker → 胖 wasm 全链(含作用域展开) | `tests/cdp-debug/`(`bun run test:e2e:cdp`) | 有 Chromium 的机 | 1/1 PASS | ✅ |
| H | 真 Chrome DevTools GUI 实连 | 见 §8 人肉清单 | 有 GUI 的机 | 人肉核对 | ⏳ 待人肉 |

A–G、I、J、K、L 已全自动化验证通过;H 需人肉(协议层已由 F 用 DevTools 前端所用同款
CDP 客户端库全验,L 又在无头浏览器里跑通了 asyncify unwind/rewind 全链)。未覆盖项见
§10、§11。

---

## §1 A —— native/core 单元测试

协议解析、`DebuggerAdapter`、`AdapterDebugTarget`、`EngineDebugTarget`、
`CDPServer`、`DevToolsService`、事件总线等的可移植 C++ 单测。

```bash
cd native/core
make clean && make test        # 改过 .h 必须 clean(无头依赖追踪)
```

**期望**:末行 `Total: 388 passed, 0 failed, 388 total`(含 `/json` 发现端点与
多 session 路由 20 例——一 socket 双租户、同租户双 session、split-port ws url、unregister/stop 释放——
+ service 层 1 例)。
Makefile 已带 `WIP_DEFS = -DRILL_WIP_CDP_DEVTOOLS=1 …`,无需额外 flag。

可选消毒器:`make asan`(地址)、`make tsan`(线程)。

---

## §2 B —— QuickJS 引擎 e2e

在打补丁的解释器上直接验断点/单步/调用栈/多租户(不经 CDP 层),纯本地 C
编译。

```bash
bash native/quickjs/test/build-run.sh
```

**期望**:`=== ALL PASS (0 failed) ===`,含:
- 行断点命中并在 runtime 线程阻塞=暂停
- 深度感知单步 into / over / out(含跨调用)
- 嵌套 `c → b → a → top` 真多层栈
- 多租户隔离(A 的断点不误命中 B;B 脱离后 A 仍暂停)

---

## §3 C —— QuickJS CDP 全栈 e2e

裸 CDP 报文经 `AdapterDebugTarget → DebuggerAdapter → QuickJSEngineDebugger →
QuickJSDebugCore → 补丁解释器` 全链路。

```bash
bash native/quickjs/test/build-run-cdp.sh
```

**期望**:`=== ALL PASS (0 failed) ===`(39 例),含 `Debugger.enable`/`scriptParsed`
往返、`setBreakpointByUrl` 解析真 scriptId、断点暂停经持久 sink 送出、
`getScriptSource`、url-keyed 断点重跑仍命中、`Debugger.resume`/`Debugger.resumed`
往返;**帧内作用域求值**——暂停帧带 Local/Closure/Global scopeChain(objectId
`<帧>:<kind>`),`evaluateOnCallFrame` 在帧作用域里解析实参/局部/闭包变量(name→
"world"、count→11、base→10 闭包捕获、name.length→5),`getProperties(0:local)`
列 name/count/msg、`getProperties(0:closure)` 列 base;以及**嵌套对象展开**——
`evaluateOnCallFrame obj` 回带 objectId 的可展开句柄,`getProperties(objId)`
列 `a=1`/`b="two"`/`nested`(子对象自带独立 objectId,可再往下钻到 `c=3`),
`Debugger.resume` 后 objectId 全部失效(回空)。

> 帧内作用域实现:门控引擎接缝 `rill_qjs_enumerate_frame_vars`/`rill_qjs_frame_this`
> 读实参/局部/闭包变量与 `this`,表达式在合成包装函数
> `(function(<名字>){return(<expr>);})` 里带当前值调用求值;非调试构建字节不变
> (已验:无接缝符号、归一化预处理输出一致)。
>
> 嵌套对象展开实现:对象/函数的 RemoteObject 现带一个暂停作用域的 objectId,
> `getProperties` 解析它并对枚举出的子对象递归铸新 id;这些 id 持有 dup 的
> JSValue,须在运行时线程释放——`QuickJSDebugCore` 在暂停退出点(持锁、抑制钩子)
> 回调引擎清空注册表,故 id 绝不跨 resume 存活(已验:ASan 相对基线仅多出测试
> 桩的 shared_ptr 环分配,无 JSValue 泄漏)。
>
> 跨引擎差异(非缺陷):「objectId 绝不跨 resume 存活」是 **QuickJS 专属**语义——
> QuickJS 一律把 objectId 绑定到暂停作用域并在暂停退出点释放(实现取舍,换 ASan
> 干净)。Hermes 侧 rill 全量转发给上游 facebook `CDPAgent`(`native/hermes/src/
> devtools/CDPAgentTarget.cpp`),objectId 生命周期由 CDPAgent 管理;按 CDP 规范,
> `Runtime` object handle 的生命周期绑定到 releaseObject/releaseObjectGroup/上下文
> 销毁而非 pause,故 Hermes 下 resume 后旧 `Runtime.evaluate` objectId 仍可解析,
> 符合规范。因此「resume 后旧 objectId 是否失效」两引擎答案不同:QuickJS 失效、
> Hermes 存活——属引擎实现差异,rill 不在 Hermes 适配层强行对齐(要对齐须 patch
> 上游 CDPAgent,超出适配层职责)。

---

## §4 D —— Hermes CDP 接真 hermes.framework(s67)

把真 `HermesRuntime + CDPDebugAPI` 接到出货的 `CDPAgentTarget`,喂裸 CDP 报文。
**须在 s67**(macOS,备有带 CDP 符号的 debug Hermes pod)。

```bash
# s67 上,checkout 于 ~/rill-arch-check(rsync 同步)。destroot 必须是 DEBUG 版
# hermes(带 CDP 符号,判别:nm <framework>/hermes | grep -c CDPAgent > 0);
# rn-macos fixture 的 Pods destroot 是 Release 版、链接必失败。已验证可用的
# 来源是 CocoaPods 缓存里的 debug 变体,例如:
HERMES_DESTROOT=$(for d in ~/Library/Caches/CocoaPods/Pods/External/hermes-engine/*/; do \
    f=$(find "$d" -path "*macosx*" -name hermes -type f | head -1); \
    [ -n "$f" ] && [ "$(nm "$f" | grep -c CDPAgent)" -gt 0 ] && { echo "${d}destroot"; break; }; done) \
  bash native/hermes/test/build-run.sh
```

**期望**:**7/7 ALL PASS** —— `Debugger.enable`/`Runtime.enable` 经 sink 往返、
`debugger;` 真暂停 runtime 线程 + `Debugger.paused` 带外送出、暂停期线程确阻塞、
`Debugger.resume` 从他线程解阻塞(副作用 `__x===42` 可见)、拆除无死锁。

> destroot 须含 `include/hermes/{hermes.h,cdp/*,AsyncDebuggerAPI.h}`、`include/jsi/*`、
> `Library/Frameworks/<platform>/hermes.framework`,且 pod 以 `HERMES_ENABLE_DEBUGGER`
> 构建(debug build 出货 CDP 符号)。

---

## §5 E —— Hermes watchdog×pause 调和(s67)

验「暂停期不计入 eval 超时预算」:暂停边界 `unwatchTimeLimit`、resume 重 arm。

```bash
# HERMES_DESTROOT 取法同 §4(必须 debug 版 hermes)
HERMES_DESTROOT=<debug destroot> bash native/hermes/test/build-run-watchdog.sh
```

**期望**:**3/3 PASS** —— 关调和时 150ms 预算的 eval 在断点上 hold 600ms →
resume 抛 `TimeoutError`(bug 坐实);开调和时不抛、程序存活跑完(`__wd==9`)。

---

## §6 F —— 真前端联调(chrome-remote-interface,Linux + s67)

`native/quickjs/tools/` 三件套(dev 工具,不进出货构建):
- `cdp_stdio_host.cpp` —— 长驻 CDP 主机(生产栈裹 guest,stdio 逐行 CDP JSON)
- `cdp_ws_bridge.js` —— WebSocket + `/json` 发现桥
- `cdp_client_probe.js` —— DevTools 前端所用同款 CDP 客户端库驱动完整会话

```bash
cd native/quickjs/tools
OUT=/tmp/cdp_host bash build-cdp-host.sh

mkdir -p /tmp/cdpbridge && cd /tmp/cdpbridge
npm install ws chrome-remote-interface
cp /ext/rill/native/quickjs/tools/cdp_ws_bridge.js \
   /ext/rill/native/quickjs/tools/cdp_client_probe.js .

HOSTBIN=/tmp/cdp_host PORT=9411 node cdp_ws_bridge.js &   # 起桥
PORT=9411 node cdp_client_probe.js                        # 跑探针
```

**期望**:**8/8 ALL PASS**:`scriptParsed → getScriptSource →
setBreakpointByUrl(真 scriptId)→ 断点命中(真 `greet → <eval>` 双帧栈)→
evaluateOnCallFrame `count=1` → resume 跑完`。桥日志应见
`host exited (code=0 sig=null)`(干净退出,非崩溃)。

> 内存消毒版:用 `-fsanitize=address -O0 -g` 编 host 再跑,期望 0 error
> —— 三个历史崩溃(teardown UAF / 启动竞态 / 缺 `Debugger.resumed`)即由此挖出。

---

## §7 G —— QuickJS-asyncify VM 级暂停 PoC(Milestone A)

证明「wasm 里的 QuickJS 在断点处用 emscripten Asyncify 卸掉整条 C 栈=真 VM
级暂停,JS 线程不卡,resume 再回卷继续」。独立 PoC(用现有 hook 接缝,不动
`quickjs.c`/调试核心/生产构建)。

```bash
source /ext/emsdk/emsdk_env.sh      # 先备好 emscripten
cd native/quickjs/poc
bash build-asyncify-poc.sh          # emcc 全量 QuickJS + asyncify
node run-poc.mjs                    # 期望 ALL CLAIMS PASS,退出 0
```

**期望**:三条断言全 PASS ——(1)断点在解释器 2 层帧深处卸栈挂起(eval 仍
pending);(2)暂停中宏任务 setTimeout(0) + 微任务照常 settle(线程未阻塞);
(3)`resume()` 回卷、eval 完成、断点行之后设的全局可见(result=43)。负对照:
去掉 `-sASYNCIFY` 后 hook 仍触发但 eval 同步返回、无法暂停——asyncify 是承重项。

> 代价:asyncify 版 wasm 约 2.9MB vs 关闭 841KB(+245%),故仅 dev/debug 构建开、
> 生产 wasm 保持 asyncify-free。**这是 Milestone A(暂停原语);接进调试核心 +
> worker 协议 + 跨 unwind 的 evaluate-on-frame = Milestone B(见 §7.1 与 §11)。**

---

## §7.1 Milestone B —— asyncify 接进调试核心 + web 端控制流

把 §7 G 的暂停原语接进真 `QuickJSDebugCore`,铺好 web 侧 JS 控制流,并打通**跨
unwind 的 evaluate-on-frame**(unwind 后活帧已弃,对暂停前捕获的绑定快照求值)。
三半各自可无 GUI 验证;唯「浏览器内 E2E」与 `awaitPromise` 仍留后续(见 §11)。

**原生半(debug wasm,需 emsdk):**

```bash
source /ext/emsdk/emsdk_env.sh
cd native/quickjs
bash build-wasm-debug.sh            # emcc 全量 QuickJS + 调试核心 + asyncify shim
node test/run-debug-wasm.mjs        # 期望 ALL CLAIMS PASS,退出 0
```

**期望**:11 条断言全 PASS ——(1)断点卸掉 C 栈(paused、eval pending、line=3);
(2)暂停中 JS 线程仍响应宏/微任务;(3)**跨 unwind 帧快照存活**(unwind 后活 C
栈已弃,读预存快照:frameCount=2、frame0Line=3);(4-5)**跨 unwind evaluate**——
挂起窗口内的同步导出跑 `JS_Call` 读快照实参(x=21)并在帧作用域算式(x*2+1=43);
(6)`resume` 在**跑过一次挂起内 evaluate 后**仍回卷跑完(result=43,证 evaluate
未扰乱被 park 的 asyncify 状态);(7)step-over 前进到新行(3→4);(8-9)evaluate
读捕获局部(local=7)、读后**改**捕获对象属性(o.x:1→5);(10)结果强转抛异常
(throwing valueOf)被排空、不泄漏进 resume 的 guest(回 sentinel、仍暂停);(11)
对象突变经 resume 传回 guest(dup 与活帧共享身份,h 回 o.x=5)。`QuickJSDebugCore`
的 web 分支用 asyncify suspend 换掉 CV 阻塞;`runOnPausedThread` 在 web 下**就地**跑
job(置空悬垂 `current_stack_frame`、抑制钩子,RAII 恢复),job 读暂停前捕获的绑定
快照。onStep 有 web 专属 `paused_` 再入门(单 resolver 无法承嵌套暂停)。生产 wasm
(`build-wasm.sh`)不含调试核心/asyncify,零影响。

**web 半(worker JS 控制流,headless):**

```bash
cd src && bun test host/web/worker/__tests__/
```

**期望**:50/50 pass(6 文件)。含 worker `dbg.*` 子协议(structured-clone 安全,
`evaluateOnCallFrame` + `getProperties`,镜像原生
`DebuggerAdapter` 结构)、串行化 eval 入口的 `TurnGate`(FIFO + suspend 排空,杜绝
重入未决的 asyncify suspend)、`dbg.paused` 解除该 turn 看门狗(断点=有意的无界
暂停,不得 `terminate()`)/`dbg.resumed` 复武装、`CdpTranslator`(CDP JSON-RPC ↔
`dbg.*`,web 版 `AdapterDebugTarget`,`Runtime.getProperties` 也归它)。**绕闸路由**
(`worker-dispatch.ts`):暂停中到达的 `dbg.evaluateOnCallFrame`/`getProperties` 是挂起
turn 上的控制面子操作,直走调试路、**不取** `TurnGate` 槽——否则会排在被挂起的 turn
后面死等(`worker-dispatch.test.ts` 实证:parked turn 下 evaluate/getProperties 仍往返、
而新 eval turn 确排队,resume 后 FIFO 排空)。真 suspend/resume 接线(debug wasm 装进
worker + `__rillDbg`)留 TODO 桩,见 §11。

---

## §8 H —— 真 Chrome DevTools GUI 实连(人肉清单)

前置:F 的桥已起(`HOSTBIN=/tmp/cdp_host PORT=9411 node cdp_ws_bridge.js`),
机器有 Chrome(s67 已装 `/Applications/Google Chrome.app`)。

- [ ] Chrome 开 `chrome://inspect` → **Discover network targets** → **Configure…**
      → 加 `127.0.0.1:9411` → 勾 Discover
- [ ] 列表出现 **rill QuickJS guest**,点 **inspect** 开 DevTools
- [ ] **Sources** 面板能看到 `guest.js`,源码完整(`function greet …`)
- [ ] 第 3 行(`var msg = …`)下断点
- [ ] 触发运行(前端自动 `runIfWaitingForDebugger` 或手动)→ 命中,右侧显示
      **Paused on breakpoint**
- [ ] **Call Stack** 显示 `greet` → `(anonymous)/<eval>` 两帧
- [ ] Console 里在暂停帧求值 `globalThis.count` → 得数值
- [ ] 点 **Resume**,程序跑完,DevTools 回到运行态(暂停 UI 清除)
- [ ] 关闭 DevTools,桥日志显示主机干净收尾

详版另见 `native/quickjs/tools/README.zh.md`。

---

## §9 s67 语法/构建验证套路(Apple 侧改动)

改动 `native/{core,hermes}` 后,对真 RN/Hermes/jsi 头做语法验:

```bash
rsync -az native/quickjs/ leo@s67:~/rill-arch-check/native/quickjs/
rsync -az native/core/src/ leo@s67:~/rill-arch-check/native/core/src/
# 单文件语法验(双态:gated + ungated),示例:
ssh leo@s67 'cd ~/rill-arch-check && clang++ -std=c++17 -fsyntax-only \
  -DRILL_WIP_CDP_DEVTOOLS=1 -DHERMES_ENABLE_DEBUGGER=1 \
  -I native/core/src -I <Pods>/Headers/Public/{hermes-engine,React-jsi,React-callinvoker} \
  -x objective-c++ native/hermes/src/...'
```

> 关键坑:Hermes 侧必须带 `-DHERMES_ENABLE_DEBUGGER=1`,否则只对
> `!HERMES_ENABLE_DEBUGGER` 的 no-op 桩「假绿」。native/core Makefile 无头依赖
> 追踪,改 `.h` 必须 `make clean`。

---

## §10 出货零足迹核对

- [ ] 全部 CDP 代码门控 `RILL_WIP_CDP_DEVTOOLS`(+ 引擎 `RILL_QJS_DEBUG` /
      `HERMES_ENABLE_DEBUGGER`);默认关 + `!NDEBUG` 门控
- [ ] `quickjs.c` 无 `RILL_QJS_DEBUG` 编译:宏折叠成 no-op,引擎字节不变(已验)
- [ ] release fixture 无 `.debug_*` 段(DWARF-free 守卫单测)
- [ ] 扫描无 CJK / AI 痕迹 / `sleep` 同步
- [ ] `native/quickjs/tools/` 为 dev 工具,不进任何构建(podspec / Makefile 均不含)

---

## §11 已知限制 / 未覆盖

以下为**当初就明确「留线外 / 后续」**的项,不在上表覆盖范围(详见
`local/cdp-debugger-guest-plan.zh.md` 与记忆 `cdp-debugger-plan`):

- **已补齐(原「后续/承诺项」,本轮完成)**:`evaluateOnCallFrame` 帧内作用域
  (实参/局部/闭包 + `this`,§3 C 已验);Phase-4 目标发现端点 `/json` + Target-
  attach sessionId 路由的**可移植核心**(§1 A native/core 384 已验);QuickJS-asyncify
  的**暂停原语 Milestone A**(§7 G PoC 已验);**嵌套对象展开**——objectId 注册表 +
  暂停退出释放钩子,子对象递归铸 id(§3 C 已验);QuickJS-asyncify **Milestone B 核心**
  ——`QuickJSDebugCore` 的 web 构建以 asyncify suspend 换掉 CV 阻塞、跨 unwind 保存
  帧快照(debug wasm `build-wasm-debug.sh` + `test/run-debug-wasm.mjs` 11/11 claims 已验);
  Milestone B **web 端 JS 控制流**——worker `dbg.*` 子协议、串行化 eval 入口的
  TurnGate、CDP↔dbg 翻译器、绕闸路由(`src/host/web/worker` 单测 50/50 已验);
  **跨 unwind 的 evaluate-on-frame**——暂停前捕获帧绑定快照、挂起窗口内同步导出跑
  `JS_Call` 对快照求值(悬垂帧指针置空 + 钩子抑制 + `paused_` 再入门 + 异常排空),
  对象突变经 dup 身份传回 guest(§7.1 debug wasm 11/11 已验,含对抗性复审收口的四项:
  异常排空、web 再入门、RAII 恢复、teardown 释放);发现端点的 **Apple 传输 HTTP 监听**
  (loopback 双监听,**配置端口 = /json discovery、ws 挪 port+1**——chrome://inspect
  对配置的 host:port 发 /json 探测,所有 `webSocketDebuggerUrl` 由
  `CDPTransport::webSocketPort()` 指向真 ws 口;§1 A `parseRequestLine`/split-port
  已验,s67 真 Network.framework 双监听运行时 e2e 6/6 已验);**PR #30 review 五修复**
  ——多 session 虚拟连接、Apple 端口对调、Hermes CDPAgent in-flight shared_ptr、
  TimerManager 回调过 TurnGate、build.sh debug guest 清单(§1 A/§0 J 已验);**胖 CDP debug wasm**——把真 CDP 引擎
  (`AdapterDebugTarget → DebuggerAdapter → QuickJSEngineDebugger → core`)编进 asyncify
  wasm,直接讲原始 CDP,浏览器/worker/relay 退化为哑管道(`build-wasm-cdp.sh` +
  `test/run-cdp-wasm.mjs` 8/8 已验;单一序列化来源,不在 TS 里重实现 CDP);
  **web 端胖-wasm 驱动**——`CdpDebugSession`(worker 内,真 wasm 65/65,含 parked+排队)+
  代码分割守卫(`src/host/web/worker`);**反向隧道 relay**——页面出站 WS 到 relay,
  relay 桥接外部 CDP 客户端 + `/json` 发现(`src/host/web/tools/cdp-relay.mjs` 4/4);
  **浏览器内 E2E**——无头 Chromium 跑通「原始 CDP 客户端 → relay → 页面 → 模块 worker →
  胖 wasm → 回」全链:asyncify 在浏览器引擎里 unwind/rewind、`evaluateOnCallFrame`
  暂停中经线传回实参/局部/闭包、resume 跑完 guest(`tests/cdp-debug/` Playwright,
  `bun run test:e2e:cdp`,1/1 PASS);**`Runtime.getProperties` 的 CDP 路由**——
  `AdapterDebugTarget.dispatch` 改为按域路由:Debugger 域走原处理链,Runtime 域把
  `getProperties` 接到引擎(新增 `DebuggerAdapter::handleGetProperties`)、对前端 attach
  握手(`enable`/`runIfWaitingForDebugger`)回 ack;仅在目标独占单引擎(胖 CDP wasm)
  时生效,原生多目标路径仍由 `RuntimeAdapter` 认领 Runtime(裸 CDP 实证:
  `run-cdp-wasm.mjs` `getProperties(0:local)` 列出帧局部 9/9;浏览器内 E2E 经线展开局部
  作用域)。
- **后续 / 承诺项(仍未做)**:`awaitPromise`(挂起期不能泵微任务,故返回未 await 的
  Promise);Apple `/json` 监听的**真机 GUI 呈现**(须 s67 GUI 或 webinspectord)。
- **留线外(非当前需求)**:原生/端上 wasm 调试(G6);Windows / N-API Hermes
  CDP;JSC 作为 CDP(接受 dev-only Safari、永不出货)
- **剩余非阻断(需异机/GUI 人肉)**:§8 H 真 Chrome GUI;Chrome DWARF opt1 局部
  变量保真;嵌套 JSContext 经 webinspectord 呈现(Safari GUI);Android
  hermestooling aar 符号(s68/s69)
