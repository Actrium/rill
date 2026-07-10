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
| A | 协议/适配器/服务/接缝 + `/json` 发现端点 单元 | `native/core` `make test` | 任意 | 379/379 | ✅ |
| B | QuickJS 引擎:断点/单步/真栈/多租户 | `native/quickjs/test/build-run.sh` | 任意(本地 C) | 26 ALL PASS | ✅ |
| C | QuickJS CDP 全栈(裸 CDP 报文)+ 帧内作用域求值 | `native/quickjs/test/build-run-cdp.sh` | 任意 | 30 ALL PASS | ✅ |
| D | Hermes CDP 接真 hermes.framework | `native/hermes/test/build-run.sh` | **s67**(需 destroot) | 7/7 ALL PASS | ✅ |
| E | Hermes watchdog×pause 调和 | `native/hermes/test/build-run-watchdog.sh` | **s67** | 3/3 PASS | ✅ |
| F | 真前端(chrome-remote-interface)经真 WS | `native/quickjs/tools/` 三件套 | Linux + **s67** | 8/8 ALL PASS | ✅ |
| G | QuickJS-asyncify VM 级暂停/恢复 PoC(Milestone A) | `native/quickjs/poc/`(需 emsdk) | 任意(emcc+node) | 3/3 claims PASS | ✅ |
| H | 真 Chrome DevTools GUI 实连 | 见 §7 人肉清单 | 有 GUI 的机 | 人肉核对 | ⏳ 待人肉 |

A–G 已全自动化验证通过;H 需人肉(协议层已由 F 用 DevTools 前端所用同款 CDP
客户端库全验)。未覆盖项见 §10。

---

## §1 A —— native/core 单元测试

协议解析、`DebuggerAdapter`、`AdapterDebugTarget`、`EngineDebugTarget`、
`CDPServer`、`DevToolsService`、事件总线等的可移植 C++ 单测。

```bash
cd native/core
make clean && make test        # 改过 .h 必须 clean(无头依赖追踪)
```

**期望**:末行 `Total: 379 passed, 0 failed, 379 total`(含 `/json` 发现端点 11 例 + service 层 1 例)。
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

**期望**:`=== ALL PASS (0 failed) ===`(30 例),含 `Debugger.enable`/`scriptParsed`
往返、`setBreakpointByUrl` 解析真 scriptId、断点暂停经持久 sink 送出、
`getScriptSource`、url-keyed 断点重跑仍命中、`Debugger.resume`/`Debugger.resumed`
往返;以及**帧内作用域求值**——暂停帧带 Local/Closure/Global scopeChain(objectId
`<帧>:<kind>`),`evaluateOnCallFrame` 在帧作用域里解析实参/局部/闭包变量(name→
"world"、count→11、base→10 闭包捕获、name.length→5),`getProperties(0:local)`
列 name/count/msg、`getProperties(0:closure)` 列 base。

> 帧内作用域实现:门控引擎接缝 `rill_qjs_enumerate_frame_vars`/`rill_qjs_frame_this`
> 读实参/局部/闭包变量与 `this`,表达式在合成包装函数
> `(function(<名字>){return(<expr>);})` 里带当前值调用求值;非调试构建字节不变
> (已验:无接缝符号、归一化预处理输出一致)。

---

## §4 D —— Hermes CDP 接真 hermes.framework(s67)

把真 `HermesRuntime + CDPDebugAPI` 接到出货的 `CDPAgentTarget`,喂裸 CDP 报文。
**须在 s67**(macOS,备有带 CDP 符号的 debug Hermes pod)。

```bash
# s67 上,checkout 于 ~/rill-arch-check(rsync 同步)
HERMES_DESTROOT=/Users/leo/actrium/actro/apps/macos/actro/Pods/hermes-engine/destroot \
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
HERMES_DESTROOT=/Users/leo/actrium/actro/apps/macos/actro/Pods/hermes-engine/destroot \
  bash native/hermes/test/build-run-watchdog.sh
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
> worker 协议 + 跨 unwind 的 evaluate-on-frame = Milestone B(见 §11 后续)。**

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
  attach sessionId 路由的**可移植核心**(§1 A native/core 379 已验);QuickJS-asyncify
  的**暂停原语 Milestone A**(§7 G PoC 已验)。
- **后续 / 承诺项(仍未做)**:QuickJS-asyncify **Milestone B**——接进
  `QuickJSDebugCore`(web 构建用 asyncify suspend 换掉 CV 阻塞)+ worker 协议 +
  跨 unwind 的 evaluate-on-frame 重设计(unwind 后 C 栈已弃,是真难点,weeks-scale);
  发现端点的 **Apple 传输 HTTP 监听**(`nw_ws` 不出 GET,须第二个 plain-TCP 监听或
  首字节嗅探,s67 spike);scope 内嵌套对象展开(`getProperties` 现只到 scope 层、
  对象值按描述不带二级 objectId)。
- **留线外(非当前需求)**:原生/端上 wasm 调试(G6);Windows / N-API Hermes
  CDP;JSC 作为 CDP(接受 dev-only Safari、永不出货)
- **剩余非阻断(需异机/GUI 人肉)**:§8 H 真 Chrome GUI;Chrome DWARF opt1 局部
  变量保真;嵌套 JSContext 经 webinspectord 呈现(Safari GUI);Android
  hermestooling aar 符号(s68/s69)
