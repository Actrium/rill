# rill 框架增强路线（与 canvas / 原生-guest 无关）

> 本文是一份**框架自身**的迭代增强路线，聚焦 rill 作为 sealed-guest 运行时的健壮性 / 正确性 / 性能 / 可观测 / DX，**刻意排除** canvas / 图形 / 原生 WASM-guest 那条独立的能力线。
>
> **产出方法**：从 rill 各视角对 10 个子系统做只读调研 → 对每个候选主题做**对抗式评审**（默认怀疑，逐条回源核实）→ 综合成按「触发条件」分档的三阶路线。所有条目都带 `文件:行` 证据。评审过程中修正了多处初始调研的失实表述，见 §7。

---

## 0. 一页速览

| 阶段 | 目标 | 触发 | 风险 |
|---|---|---|---|
| **Phase 1 · 诚实性与主路径健壮性** | 在用户真实命中的 web 主线程 + JSON 活桥上，堵住会致**数据静默丢失 / 主线程挂起 / 暂停态 OOM**的真实缺口，清理死字段与无结构诊断的诚实性欠账 | 立即（全部 S、低风险、零新抽象） | 触碰 `shared/serialization` 会波及 `host:store` 活桥，须以活桥回归把关 |
| **Phase 2 · 可观测性与 DX 基建** | 接线「瓶颈可定位 / 错误可聚合 / 样板可复用 / 关停可对账」的横切基建，落地唯一真实的运行时热路径胜点（prop diff） | Phase 1 稳固后 | 范围易膨胀成「到处塞诊断」，须锚定不外扩；诊断绝不入 render 热路径 |
| **Phase 3 · 战略架构** | 承接被原生 host/JSI/C++、guest-WASM provider 选型、或「第二个破坏性协议版本尚未出现」卡住的架构级能力 | 各项独立**条件触发**，坚决不预造抽象 | 过早定型 = 长期兼容负债；TS 层伪强制 = 安全剧场 |

**承重原则（贯穿全程）**
1. **默认编码是 JSON**；二进制路径服务尚未上线的原生/RN host。不为二进制极端输入（intern 65535、denormal、超深对象）投机硬化，留到原生 host 进 RC 随原生一起做。
2. **硬安全边界 = CSP `frame-ancestors` + build deny-list，不在 TS 层做强制**。TS 层的配额/权限/负向断言只是可观测性，绝不当硬边界（同 realm 可绕），否则误导后续安全决策。
3. **静默降级是刻意契约**（QuickJS `guest-sees-null`、`element-transform` Fragment 回退、循环引用降级）：只在 **host 侧并行发结构化诊断，绝不改 guest 可见行为**。
4. **主线程 Engine 是平台真实运行时**（`runtime.tsx` `new Engine` + 同步注入 host 模块）；`WorkerEngine` 当前零使用。worker 成熟度是正当 roadmap 项而非关键路径。
5. **诚实优先于投机**：死字段要么落地要么删除；只有 v1、无外部客户端时不预造版本协商/弃用框架——方案定错的代价高于暂时没有。
6. **`element-transform` 是标注过的 perf 热路径**（禁 `console`、禁结构/循环引用遍历，一次遍历 100–500ms）；任何诊断/审计插桩必须廉价。
7. **死代码在证明有调用方之前不优化**（`performance.ts` 的 `getItemOffset` cumsum / `OperationMerger`，全树零消费者）。

---

## 1. Phase 1 — 诚实性与主路径健壮性（近期）

> 全部 S 级、低风险、零新抽象、不触信任边界语义。互不依赖、可并行。

### 1.1 坏批次隔离：`onGuestOperations` 包裹 `applyBatch`
- **问题**：`applyBatch` 内部已有 **per-op try/catch**（`src/host/receiver/receiver.ts:212-221`，逐操作隔离），但**调用方** `onGuestOperations`（`src/host/engine/engine.ts:688-695`）未包裹 `applyBatch` 调用——若 `applyBatch` 在 per-op 保护之外抛出（批次装配/背压逻辑），会掀翻整条渲染管线。
- **改法**：`onGuestOperations` 里 `try/catch` 包裹 `applyBatch`，隔离该批次、记 diagnostics、不掀翻管线。
- **测试**：注入一个会让 `applyBatch` 顶层抛出的批次 → 断言管线存活、diagnostics 记录、后续批次仍正常应用。
- **验收**：坏批次被隔离并上报，渲染管线不崩。
- **附带（follow-up，不在本项）**：per-op 失败后的**树状态一致性**（orphan 节点、`parentByChildId` 不同步，`receiver.ts:212-221`）是更深的事务语义问题，另立 follow-up，勿混入本 S 级修复。

### 1.2 暂停态事件队列硬上限
- **问题**：`engine.ts:1789-1799` 暂停（pause）时 `sendEvent` 入队无上限，`paused-but-fed` 可 OOM。此为**基类 Engine 逻辑，对 web QuickJS/WASM 主路径同样生效**。
- **改法**：`_eventQueue` 加硬上限（按名 coalesce 或 drop-oldest）+ 累计 `dropped` 计数 + `resume` 时 `warn`。
- **测试**：pause 后灌入 > 上限的事件 → 断言队列截断在上限、`dropped` 计数正确、`resume` 输出 `dropped` 告警、无 OOM。
- **验收**：暂停态队列超限时按上限截断并在 `resume` 输出 `dropped` warn。

### 1.3 JSON 边界正确性（web 活桥切片）
- **问题**（均在已上线 JSON 路径）：`src/shared/.../type-rules.ts:144` 循环引用**静默**转 `undefined`（数据丢失无告警，触及信任面）；`serialization.ts:112-232` `createEncoder` 有 `depth` 变量但无最大值检查、无大小上限；JSON 路径 `NaN/Infinity` 丢失。
- **改法**：循环引用降级时加**明确 warn**（保留降级但不再无声丢数据）；`createEncoder` 补 `depth`/`size` 硬上限防超深对象放大；`NaN/Infinity` 显式处理。
- **测试**：编码循环引用 → 断言 warn 触发且降级可观测；超深/超大对象 → 断言硬上限触发；`NaN/Infinity` 经 JSON → 断言显式处理。**并以 `host:store` 活桥端到端回归把关**（`shared/serialization` 被活桥复用）。
- **验收**：循环引用/`NaN`/`Infinity` 经 JSON 路径产生可观测告警而非静默丢数据；`host:store` 活桥无回归。

### 1.4 死字段 `timeoutMs` 诚实性
- **问题**：`RpcOptions.timeoutMs` 定义并透传（`src/contract/index.ts:17,23,163`），但 `createHostModuleDispatch` / `wrapRpcDispatch`（`index.ts:418-458`）**从不读取**；硬超时已由 `worker-engine` 的 per-turn watchdog（默认 5000ms `terminate` 整个 worker）结构性兜底。缺的只是「每-RPC 软超时」这一便利。
- **改法（二选一）**：要么在 `wrapRpcDispatch` 用 `Promise.race` 落地**软超时**（须想清超时后实现仍在跑的清理，勿与 watchdog 硬 kill 语义冲突）；要么**直接删除死字段**（更诚实、更省）。
- **测试**：若落地——慢 RPC 在 `timeoutMs` 处超时且资源被清理；若删除——类型/编译断言字段已移除，watchdog 硬超时测试仍在。
- **验收**：`timeoutMs` 不再是 dispatch 从不读取的死字段。

### 1.5 CLI 结构化诊断（最低风险果子）
- **问题**：`src/cli/build.ts:385` 仅记录 文件名+message；`oxc-adapter.js:196` `console.warn` 无结构化上下文。故障定位推迟到运行时。
- **改法**：构建/转换失败的 `console.warn` 补结构化字段（file/line/phase/rule）。
- **测试**：构造一个构建错误 → 断言输出含结构化上下文（file/phase）而非裸字符串。
- **验收**：构建错误带可机读的结构化上下文。

---

## 2. Phase 2 — 可观测性与 DX 基建（中期）

> 增量、向后兼容、不扩大沙箱信任面。诊断只在 host 侧并行发，绝不改 guest 可见行为。

### 2.1 prop diff：`commitUpdate` 只序列化变更 prop
- **问题**：`serializeProps`（`src/host/.../host-config.ts:279-281`）**无条件全量序列化**，命中每次带 props 的 React 重渲染。
- **改法**：`commitUpdate` 里 `oldProps` 已在手、`removedProps` 已由 `getRemovedProps` 算出，接收端 `receiver.handleUpdate` 已是合并语义（`node.props={...old,...new}`+`removedProps`）——**改成只序列化变更 prop**，几乎零协议改动（对称扩展现有 removed-key diff 为 changed-key diff）。
- **测试**：一次只改一个 prop 的 update → 断言仅该 prop 上桥；且在合并语义下最终 props 与全量序列化**逐字段等价（无损）**（golden 对拍）。跑现有 reconciler 测试保证无行为回归。
- **验收**：仅变更 prop 上桥、与全量序列化等价。

### 2.2 分段初始化/构建指标
- **问题**：`engine.ts:600-649` `initializeRuntime` 多阶段但仅整体记录一次耗时；`build.ts:676,904` 仅总构建耗时。瓶颈无法定位。`onMetric` 钩子已存在。
- **改法**：`initializeRuntime` 各阶段（createRuntime/bridge/polyfills/runtimeAPI）补一次 `onMetric` 上报；build 各阶段补分段耗时。纯增量。
- **测试**：断言各阶段产出独立命名的耗时指标，可定位单阶段瓶颈。
- **验收**：init 与 build 各阶段可独立观测。

### 2.3 结构化错误上下文 + devtools 按类型聚合
- **问题**：`engine/types.ts` 已有 `RequireError/ExecutionError/TimeoutError`（**非「无类型区分」**），`contract` `runBoundary` 已传 `{moduleId,exportName,phase}` 并保留 cause（**非「无上下文」**）——真缺口只两块：已有错误类**缺 `batch/operation序号/module` 等 context 字段**；devtools `recordSandboxError`（`runtime.ts:280-283`）**仅计数**，无法回答「什么错/哪个批次/哪个模块」。
- **改法**：给已有错误类补 context 字段；`recordSandboxError` 从「计数」升级为收结构化错误对象以支持按类型聚合。**纪律**：不改 `guest-sees-null` / Fragment 回退等刻意契约；`element-transform` 热路径诊断必须廉价（不做栈遍历、不碰跨桥循环引用）。
- **测试**：错误携带 batch/operation/module context；`recordSandboxError` 能按类型聚合而非仅 `errorCount++`。
- **验收**：sandbox 错误可按类型聚合回答「什么错/哪批次/哪模块」。

### 2.4 共享校验组合子（削样板）
- **问题**：各 host:* 各自手写 `String()/Number()/typeof`/正则校验（`host-net.ts:37-56`，`host-store` 同类约 24 处），无共享组合子，失败语义不统一。
- **改法**：提取共享校验组合子 `s.string()/s.number()/s.object({...})` 子集（纯新增工具函数，**不碰边界执行语义**），各 host 模块改用。
- **测试**：组合子与手写校验**逐用例对拍**（相同输入→相同校验结果与失败语义）；重构后各 host 模块跑**原有测试不变**通过。
- **验收**：host:* 校验样板收敛、失败语义统一、无行为回归。

### 2.5 关停资源对账（destroy 泄漏审计）
- **问题**：`engine.destroy()`（`engine.ts:2008-2066`）只做清理，缺一份「销毁时资源结算」；`guestCallbackCount` + diagnostics + 硬阈值监听器告警已具雏形。
- **改法**：`destroy()` 末尾复用现有 diagnostics/`guestCallbackCount`，输出一次销毁后残留结算（callback/componentType/timer/subscription 非零则 debug 告警）。
- **测试**：正常 destroy 后残留计数为零；故意泄漏一个 callback → 断言被审计捕获。
- **验收**：`destroy()` 输出资源残留对账。
- **辨伪（勿做）**：`getRefCount` 已是 public、`WeakMap` 组件缓存是惯用法非泄漏、一次性定时器已自清、tenant/native 分层正确——均非缺陷。

### 2.6 `createReceiver` 重复守卫（来自 receiver-web 复核）
- **问题**：`WorkerEngine.createReceiver()`（`src/host/web/worker/worker-engine.ts:196`）无 `if (this.#receiver) return`；多次 `loadBundle` 会新建 receiver、旧 refMap/nodeMap 闭包泄漏（`getReceiver` 已存在，见 `worker-engine.ts:11`）。
- **改法**：`createReceiver()` 早返回已有 receiver，或调用点改 `getReceiver() ?? createReceiver()` 并在重建前清理旧 receiver。
- **测试**：同一 engine 多次 `loadBundle`/`createReceiver` → 断言不产生泄漏的旧 receiver。
- **验收**：重复加载不泄漏 receiver。
- **注**：先验证「重复 loadBundle」是真实使用路径还是误用；若仅误用，降级为「重复创建时抛清晰错误」。

### 2.7 `render()` 节点级错误边界（来自 receiver-web 复核）
- **问题**：`receiver.ts:676-792` `renderNode`/`createElement` 抛出会让整个 `render()` 失败、无 fallback（未知组件已 `return null`，但已注册组件抛出会掀翻全树）。
- **改法**：`renderNode` 包 `try/catch`，坏节点返回 fallback（占位/隐藏）而非掀翻全树；错误旁路上报 diagnostics。
- **测试**：一个会抛的已注册组件 → 断言坏节点被隔离、其余树正常渲染、错误上报。
- **验收**：单个坏节点不掀翻全树渲染。

---

## 3. Phase 3 — 战略架构（远期，条件触发）

> 每项都至少命中一条硬约束（原生/JSI/C++ 双端绑定、guest-WASM provider 选型未定、过早抽象、扩大封口档信任面）。**全部 defer，仅在触发条件满足后逐项启动**。

### 3.1 Worker/线程模式成熟度
- **内容**：`host:*` **跨线程桥接**（`worker-engine.ts:329-339` `onReceiverToSandbox` 为 no-op → worker 里 guest 无法用任何 host 能力）；REF_CALL/callback-release（`worker-host.ts:105-108` release 为 no-op，跨线程回调单向增长）；worker 侧 postMessage 失败/错误传播（`worker-engine.ts:322-449`、`worker-host.ts:88-104`）；watchdog 未计序列化耗时（大回调误杀）。
- **触发**：出现具体重算 app 在主线程冻结 UI；且须**先做 `host:*` 桥接**（否则 worker 模式只是 demo 级）。
- **硬约束**：`host:*` 桥接绑 **COOP/COEP 跨源隔离**决策（SharedArrayBuffer+Atomics.wait），与 seal 承重墙 `frame-ancestors` 纠缠。落地前**修正证据**：`watchdogTimeout` 是可配 option（`worker-engine.ts:82`）**非硬编码**；version 握手在同包打包下价值有限。

### 3.2 运行时超时 / 取消 / 韧性
- **内容**：原生 in-page QuickJS-WASM 的 `evalCode` 同步、`timeout` 形同虚设（`quickjs-native-wasm-provider.ts:258`），guest 死循环冻结主线程；`handleRefCall`（`receiver.ts:621-672`）异步无超时；AbortSignal 治 `host:net` 孤儿 fetch；per-promise 超时。
- **触发**：guest-WASM 封口档 provider 选型敲定（in-page 原生 vs Worker async）。
- **硬约束**：可中断执行需 C/WASM 侧接入 `JS_SetInterruptHandler` + deadline 并重建 wasm 产物（非 TS 层）；Worker(async) provider 已有 timeout+forceDestroy 兜底。AbortSignal 需 contract 协议面 host+guest 双端贯通。

### 3.3 二进制协议硬化
- **内容**：intern 表溢出（`binary-encoder.ts:343` 达 65535 直接 throw，无分批/增量）、魔数/版本不匹配无回退（`binary-protocol.ts:142-148`）。
- **触发**：原生 host `InstructionFormat.h` 进 RC，须与原生侧协同（版本常量双端重复定义）。
- **硬约束**：单改 TS 端无意义甚至成死代码；给协议引入 JSON 降级分支会扩大攻击面（sealed 档下版本降级可成绕过点）。

### 3.4 API 稳定性与版本化
- **内容**：per-capability 版本 + 弃用迁移框架；双端 `PROTOCOL_VERSION` 收敛为**单一真相源**（`binary-protocol.ts:86` 与原生 `InstructionFormat.h` 重复）。
- **触发**：有真实外部 guest 分发（registry）边界 + **第二个协议版本被真实破坏性变更逼出**（而非预防性设计）。
- **硬约束**：只有 v1、无外部客户端时引入协商机制是过早抽象，方案定错代价高于暂缺。

### 3.5 原生多租户隔离与配额强制
- **内容**：权限/配额/内存/超限的**真正强制**——位于原生 C++ `RillTenantManager`（JSI，`globalThis.__RillTenantManager`）。`tenant-manager-provider.ts` 只是转发 shim，且当前**未接入** `application.ist`。
- **触发**：有原生/移动目标且 C++ 层规划就绪；**主战场在 C++ 不在此 TS 仓**。
- **硬约束**：在 TS 层加检查=可被同 realm 绕过的**伪强制/安全剧场**（承重原则 2）。唯一对 web 主路径生效的碎片（暂停队列上限）已提到 **Phase 1.2**。

### 3.6 测试门禁升级（见 §6）
- **内容**：`benchmarks.yml` 从计时 smoke → committed `__benchmarks__` + **方差感知的相对回归% 基线**（binary-vs-JSON 尺寸/吞吐）；`provider-contract` 增补安全负向用例。
- **触发**：出 beta / 有真实用户与并发负载。

---

## 4. 明确不做（drop）+ 理由

| 项 | 为什么 drop |
|---|---|
| `performance.ts` `getItemOffset` cumsum / `OperationMerger` 优化 | **全树零消费者**（含 tests/build 均不调用），是未接线死代码；优化前必须先证明有调用方，否则纯自嗨、零用户影响 |
| receiver `indexOf` 「O(n²)」改造 | **stale**：已用 `rootChildrenSet/nodeChildrenSet/parentByChildId`（`receiver.ts:42-46`）做 O(1) 缓解，残余是数组有序兄弟 splice 的固有成本 |
| 契约「部分 schema 全有或全无」 | **前提错误**：`BoundarySchema.parseInput/parseOutput` 本就各自可选（`contract/index.ts:11-13`，`wrapRpcDispatch` 独立判断 430/444），只给一个完全合法 |
| 异步 schema 校验 | 跨运行时信任边界做 async 校验引入 **TOCTOU/重入**面；`parseOutput` 已能 await 实现的异步结果，缺的只是异步 schema 本身，无实证需求 |
| 双向「RPC 进行中 guest 现场回调」 | 让 guest 函数在 host RPC 中途被回调，**显著扩大封口档攻击面**，与 guest-WASM 真封口方向相悖（`guestExports`/`subscription` 已覆盖正常的 host→guest 方向） |
| engine-view 高频 `handleUpdate` debounce | 已有 `safeQueueMicrotask` 去重（`receiver.ts:277`）+ React 批处理；对小树/近零用户属投机 |
| keyboard 订阅冲突日志 / O(n) 遍历微优化 | DX 镀金 / 微优化（订阅数极少），无真实痛点 |

---

## 5. 依赖与排序理由

- Phase 1 全部**落在已上线主路径 + 真影响正确性/数据完整性 + 低成本 + 无外部依赖**，互不依赖、可并行，故先行基线。
- Phase 2 依赖 Phase 1 的诚实基线（结构化诊断需先有干净降级语义）；**prop diff 的正确性前提**是 `receiver.handleUpdate` 已是合并语义 + `removedProps` 已算出；分段指标依赖已存在的 `onMetric` 通道。
- Phase 3 各项被外部决策卡住，按触发条件逐项启动，**坚决不预造抽象**。

---

## 6. 测试策略（一等公民）

**现状（回源核实，务必先认清）**：rill **并非缺乏测试**——`src/` 下有 **96 个 `.test.ts`**；engine 核心有 `src/host/__tests__/{unit,integration,e2e}`（约 30 个 `engine.*.test.ts`）；receiver 有 `receiver.test.ts` + `receiver.delete-performance.test.ts` + `performance.*.test.ts`；`binary-encoder.test.ts` 含 binary-vs-JSON 对比；`provider-contract.test.ts` 跨 5 个 provider 参数化；git 有专门加固批次（`close high-severity sandbox coverage gaps` 等）。CI 有 `ci.yml`（preflight/bundle/native/e2e:wasm）+ `benchmarks.yml`。**「核心模块缺测试」是失实前提**。

**真正的窄缺口**（→ Phase 3.6，条件触发）：
1. `benchmarks.yml` 只是计时 smoke，**无带回归阈值的性能门禁**、无 committed `__benchmarks__` 追踪 binary-vs-JSON 吞吐/尺寸曲线。落地须用**相对回归%**（而非绝对阈值）+ 方差感知，避免 shared runner 上 flaky 红灯。
2. `provider-contract` 缺**安全负向**用例（`__proto__`/原型污染、seal 后访问 `__rill`、host fn 参数逃逸）。**须在文档标注：JS 层断言 ≠ 透明边界，承重墙仍是 CSP + deny-list**（承重原则 2），防止制造「已强制」假象。
3. 压测规模偏小（perf 约 100 ops）：缺 1000+ ops / 内存泄漏 / 长跑 timer。

**纪律：每个 Phase 1/2 增强落地必带测试**。各条目的具体测试设计见 §1–§2 的「测试」行。汇总新增用例（含 receiver-web 复核建议）：
- **坏批次隔离**：坏批次注入 → 管线存活 + diagnostics；**失败后树一致性**（orphan/`parentByChildId` 同步）单独一组。
- **暂停队列上限**：超限截断 + `dropped` 计数 + `resume` warn。
- **JSON 边界**：循环引用/`NaN`/`Infinity`/超深对象 → 告警/上限；**`host:store` 活桥端到端回归**（承重原则 8）。
- **prop diff**：仅变更 prop 上桥 + 与全量序列化逐字段等价（golden 对拍）。
- **校验组合子**：与手写校验逐用例对拍 + 各 host 模块原有测试不变通过。
- **destroy 对账**：正常残留为零 + 故意泄漏被捕获。
- **createReceiver 重复**（receiver-web）：多次 loadBundle 不泄漏旧 receiver。
- **render 错误边界**（receiver-web）：坏节点隔离、其余树正常。
- **onLoad 异常 / renderError 异常**（receiver-web）：integrator 回调抛出不使引擎/视图崩溃（防御式包裹）。
- **集成**：receiver + keyboard + worker 端到端交互（补并发/边界）。

---

## 7. 评估证据勘误（诚实记录）

对抗式评审 + receiver-web 复核回源核实，修正了初始调研的多处失实——**避免按被夸大的威胁模型过度工程**：

| 初始表述 | 核实结论 | 证据 |
|---|---|---|
| `applyBatch` 无 try/catch | **已有 per-op try/catch**；真缺口是调用方未包裹 + 失败后树一致性 | `receiver.ts:212-221` |
| `RECEIVER_BACKPRESSURE` 全树不存在 | **存在**；缺的是标准响应处理 + skip 粒度（仅计数，无操作 ID） | `receiver.ts:262` |
| `watchdogTimeout` 硬编码 | **可配 option** `options.watchdogTimeout ?? 5000` | `worker-engine.ts:82,127` |
| `timeoutMs` 无兜底 | 硬超时由 worker per-turn watchdog 结构性兜底；缺的仅「每-RPC 软超时」便利 | `contract/index.ts:17,23,163` |
| 契约「部分 schema 全有或全无」 | `parseInput/parseOutput` 本就各自可选 | `contract/index.ts:11-13,430,444` |
| 核心模块缺测试 | **96 个测试文件** + engine/receiver/provider 全套 + git 加固批次 | `find src -name '*.test.ts'` = 96 |
| receiver `indexOf` O(n²) | 已用三层索引做 O(1) 缓解 | `receiver.ts:42-46` |
| `getRefCount` 未暴露 / WeakMap 组件缓存泄漏 / callbackId 溢出 | 均非缺陷：`getRefCount` 已 public、WeakMap 缓存是惯用法、定时器已自清 | callback-registry / element-transform |
| 多租户 TS 层「配额未强制」 | TS shim 本就不该强制（强制在原生 C++）；TS 层加检查=安全剧场 | `tenant-manager-provider.ts` 为转发 shim |

---

## 附：本路线的产出方法

10 子系统只读调研（cli / contract / guest / engine / sandbox / receiver-web / tenant-manager / performance-bridge / devtools / sdk-shared）→ 每主题独立**对抗式评审**（默认怀疑、逐条回源、判 keep/drop/defer）→ 综合。`receiver-web` 子系统单独复核补全。全部条目回源到 `文件:行`，勘误见 §7。
