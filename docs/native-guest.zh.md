# rill 原生（非-JS）WASM guest —— 地基

> 站在 rill 的角度，把「非-JS 绑定的原生 WASM guest」这条扩展的**地基**设计并夯实：让 app 直接编译成 `.wasm`（Rust / C / Zig…）作为 sealed guest，host:* 作 WASM import。**canvas 只是它日后的消费者之一**（重计算/原生库复用/polyglot 同样受益）——本文不被 canvas 这个具体需求束缚。
>
> 本文既是设计，也记录**已落地的 Phase A + B + C**：宿主侧 ABI（`WasmGuestHost`）+ 人体工学 Rust guest SDK（`store::put(k,v).await`、声明式 `render(view([text(…)]))`）+ 真 Rust `.wasm` guest 的 host:* 往返、封口负向、**渲染批次经真 receiver 物化出 UI**，全部 `bun test` 跑绿。

---

## 0. 定位

rill 现状 = **QuickJS-WASM 跑 JS guest**（沙箱是一个 WASM 模块，里面跑应用的 JS）。本扩展（记为 **②**，区别于 canvas 文档里的阶段号）= 让 **guest 本身就是原生编译的 `.wasm`**，不再套一层 QuickJS。

它把 rill 从「QuickJS 上的 sealed JS 框架」升级成「**语言中立的 sealed WASM 平台**」：多语言 guest、高性能层惠及**所有重计算**（加解密/编解码/ML/sqlite/ffmpeg 移植…不止图形）、复用现成原生库、把 host:* 边界形式化成**语言中立 ABI**、零拷贝数据路径、封口论证回归 WASM 本质。

「打好基础」= 先夯**装载模型 + 语言中立 host:\* ABI（含异步）**，再谈渲染 / canvas / 多语言 SDK。

## 1. 关键洞察：异步不用重造

回源发现：rill 现有的**隔离域（WASM）host 调用本来就是「同步 post + 回调 resolve」**——guest 同步 `__sendToHost` 拿即时返回，真正的异步结果由 host 之后**按 callback id 回调 guest**来 resolve（`__rill.callbacks` / `invokeCallback`，见 `src/host/sandbox/providers/quickjs-native-wasm-provider.ts`）。

原生 guest 的异步用**同一套模型**，只是把「JS 值 + `__sendToHost`」换成「**线性内存指针 + 导出函数**」。所以 ② **不是发明异步，是把现有 sync-call + callback-resolve 形式化成语言中立 ABI**——这是地基能稳、且与现有实现同构的原因。

## 2. 地基三件

**① 装载模型**（平行于现有 `loadBundle → evalCode(JS)`）：新增 `WebAssembly.instantiate(appWasm, importObject)`，注入 host:* + 运行时导入，调 guest 导出入口。它**不是** `JSEngineProvider`（那是「JS 引擎跑 JS」）——是「实例化 app 自己的 `.wasm`」这一新概念，由 `WasmGuestHost` 承载。

**② host:\* ABI（线性内存，语言中立）—— 地基核心**：字节按**指针+长度**在 guest 线性内存里传，host 持 guest 的 `Memory` **零拷贝读**。比 QuickJS 路线的序列化拷贝 + `number[]` 绕 TypedArray 疤**更简单更快**。完整 wire 见 §4。

**③ 封口（回归 WASM 本质）**：`importObject` 完全由 host 控制。guest 只拿到 host:* + `rill_alloc`/`rill_log`，**无 fetch / socket / RTC**（WASM 无 ambient 网络，host 不导入就没有）；**未声明的 host 模块 fail-closed**（resolve `ok=0`）。封口由 **WASM import 模型结构性保证**——比「QuickJS 恰好没有 fetch」更标准可审。发布判档（声明的能力 + egress → green/lime）不变。

## 3. 与现有 QuickJS 兼容——加法式，不动现有

**共享、一行不改**（兼容的根本）：
- **host:\* 派发层**（`createHostModuleDispatch`）+ 契约 + 壳层 broker + 信任/闸门——两类 guest 打进**同一批 host 实现**，`host:store` 写一遍、JS guest 和原生 guest 都用。`WasmGuestHost` 直接复用 `createHostModuleDispatch` 的产物。
- **渲染 receiver + 二进制 op 批次协议**——原生 guest（Phase C）发**同一套渲染批次**，receiver 照旧物化。
- **异步 callback-resolve 模型**——现有 QuickJS 用的就是它，原生 ABI 用同一套（只换载体），异步语义一致、不是兼容裂缝。

**新增/不同的只有 guest 侧那根线**：QuickJS 走「JS 值 `__sendToHost`/`__rill_fn_ret`」，原生走「线性内存 `ptr+len` 的 `rill_host_call`/`rill_resolve`/`rill_alloc`」。**这两根线是同一派发层上的两个适配器**——原生桥把线性内存字节解码成派发层期望的值形状 → 跑现有 `parseInput/impl/parseOutput` → 结果编码回 guest 内存。**派发层不变 → QuickJS 路径原封不动 → 零回归**。

一句话：**现有 QuickJS-WASM 是这个底层 host↔WASM 接口的一个「消费者」（它在上面跑 JS）；原生 guest 是另一个消费者。② 是把 QuickJS 早在用的那条桥抽成语言中立 ABI，不是替换它。**

**v1 兼容 / 终局最优**：首版走「原生桥把字节解码成派发层今天期望的值形状」（派发层偏 JS 值，还带 `number[]` 绕 TypedArray 的疤），以**复用现有派发、零回归上线**。**终局是最优性能**——让派发层原生走字节、**零拷贝到底**，并把 QuickJS 那条桥也重构到这条统一 ABI 上（收成一条边界）。

之所以敢「先兼容、后重构求最优」，是因为**这层是内部边界、不在顶部**：app 作者写高层 SDK（`store::get().await`），不直接碰 `rill_host_call`；QuickJS 那条桥更是纯内部实现。所以**内部调整安全**，v1 刻意**不过度冻结** ABI 的形状。

**诚实的临界点**：一旦有**预编译的原生 guest 被分发**（不再随 host 版本一起重编），ABI 就从「可自由 churn 的内部边界」变成「带版本的兼容面」——那时才需要 api 版本化处理（与 rill api-stability 的触发条件一致：等真实外部分发边界出现再定型，不预造）。在那之前，内部重构求最优是安全且预期内的。

## 4. ABI v0 规格（headless / 地基，已实现）

**host → guest imports**
| import | 签名 | 语义 |
|---|---|---|
| `env.rill_host_call` | `(mod_ptr,mod_len, method_ptr,method_len, in_ptr,in_len, cb_id)` | guest 发起一次 host:* 调用；**同步返回、不阻塞**；结果稍后经 `rill_resolve` 回来 |
| `env.rill_log` | `(ptr,len)` | guest 日志 |

**guest → host exports**
| export | 签名 | 语义 |
|---|---|---|
| `memory` | — | guest 线性内存，host 零拷贝读 |
| `rill_alloc` | `(size) -> ptr` | host 要往 guest 内存写结果时，让 guest 分配缓冲 |
| `rill_resolve` | `(cb_id, ok, res_ptr, res_len)` | host 异步完成后调它，把结果交回 guest（驱动 guest 侧 future/Promise） |
| `rill_init` | `()` | 入口 |

**wire**：请求/响应字节是 guest 线性内存里的 **UTF-8 JSON**，按 `(ptr,len)` 寻址。`ok=1` 正常、`ok=0` 失败（body 为 `{error}`）。

> JSON 是地基阶段的务实选择（与现有 JSON 默认编码一致、跨语言好实现）；高频/大载荷路径后续可换二进制编码，ABI 形状不变。

## 5. Phase A 已落地 + 后续

**Phase A · 装载 + ABI（本 PR，已跑绿）**
- `src/host/wasm-guest/wasm-guest-host.ts` —— `WasmGuestHost`：`instantiate` + `importObject` 注入 `rill_host_call`/`rill_log`，桥接 `rill_host_call → createHostModuleDispatch → rill_resolve`，`drain()` 等待在途调用。
- `src/host/wasm-guest/__tests__/fixtures/roundtrip.wat`（+ 编译产物 `.wasm`）—— 一个**手写最小原生 guest**，`rill_init` 发一次 `host:kv.put`，wire 级看清 ABI。
- `src/host/wasm-guest/__tests__/wasm-guest-host.test.ts` —— 两个真测试：**① 端到端往返**（guest 经线性内存调 host:* → 真派发 → `rill_resolve` 回传 → 断言结果 `{version:1}` + KV 实存了 guest 的写）；**② 封口 fail-closed**（未声明模块 → `ok=0` + `not registered`）。

**Phase B · Rust guest SDK（本 PR 已落地）**：`crates/rill-guest`（lib）—— 人体工学 SDK，开发者写 `store::put(k, v).await`，crate 处理 alloc / host_call / resolve / **future**（一个 no_std 单任务 executor：host 调用是个 future，首 poll 发 `rill_host_call` 挂起，host 之后 `rill_resolve` 唤醒再 poll 完成——即 guest 侧的 callback-resolve）；ABI 导出（`rill_alloc`/`rill_resolve`/`rill_init`）+ 全局 bump 分配器 + panic handler 由 `rill_guest_main!` 宏在 guest cdylib 里生成。`crates/kv-guest` = 用它写的真 Rust guest，`crates/build.sh` 编成 `.wasm`（被 Phase A 的 `WasmGuestHost` 原样加载，测试驱动 `store::put("a","b").await` 端到端跑通）。

> **封口自证**：编出的 `kv-guest.wasm` 的 import 列表**只有 `env.rill_host_call` 一个**——guest 能触达的全部就在这张表里，无 fetch / socket / 任何网络原语。import 模型即沙箱，肉眼可查。

**Phase B 后续（未做）**：CLI 增加 `.wasm` guest 构建目标（现只出 JS bundle）、补 `host:net` 等更多能力的 typed 包装、host:store 活桥 e2e。

**Phase C · 渲染（本 PR 已落地首版）**：原生 guest 第一次**出 UI**。SDK 加了声明式构建 `ui::view([ui::text("…")])` + `render(root)`——把元素树走成一个**渲染批次**（`{version,batchId,operations:[CREATE/TEXT/APPEND…]}`）经**新增的单向 ABI 通道 `rill_send_batch(ptr,len)`** 交给 host；`WasmGuestHost` 解码成 `OperationBatch` → 转交 `onRenderBatch`（**decoupled**：host 不硬编码 receiver）→ 喂给**真 `receiver.applyBatch`** 物化。`crates/ui-guest` 渲染 `View > [Text("hello from rust"), View > Text("nested")]`，测试用 `receiver.getComponentTree()` 断言物化出的真实节点树。**这是 JS guest 用的同一条渲染路径，只是批次在 Rust 里构建。**

**Phase C 后续（未做）**：批次 wire 从 JSON 换成现有**二进制 op 协议**（`BinaryProtocol`，与 JS guest 完全一致、高频优化）；输入 / 生命周期走 `rill_on_event(ptr,len)`（复用现有事件通道）；补 host:* 全集；扩 C/Zig SDK。

**消费者（之后）**：canvas 帧缓冲 / `host:gpu`、重计算 app……见 [rill-canvas.zh.md]（application.ist 侧）。

## 6. 渲染 / 事件

渲染路径（Phase C 首版已通）：原生 guest **发渲染批次** → `rill_send_batch` → host 解码成 `OperationBatch` → 真 `receiver` 物化成 sealed 组件树，**与 JS guest 复用同一 receiver**。批次 wire 首版用 JSON（与 host:* wire 一致），后续换二进制 op 协议——ABI 通道形状不变。输入 / 生命周期走 `rill_on_event`（待接）。**canvas 的帧缓冲 present 是消费者层，地基不碰。**

## 7. 测试

已带（`wasm-guest-host.test.ts`，4 绿）：ABI 端到端往返、封口负向、真 Rust guest 的 `store::put().await`、**Rust guest 渲染批次经真 receiver 物化成节点树**。地基推进时按此纪律扩：
- **ABI 一致性**：`host_call/resolve/alloc` 字节往返的边界（空 / 大 buffer、非法 `ptr/len`、`cb_id` 复用/悬挂、`ok=0` 路径）。
- **封口负向**：guest 触达未导入能力被 fail-closed；越界 `ptr/len` 不读写 guest 内存外。
- **与 JS guest 共存**：同一 host 挂一个 JS guest + 一个原生 guest（多 Engine），互隔离。
- 接平台后：走 `host:store` 活桥 e2e。

## 8. 源码索引

| 关注点 | 位置 |
|---|---|
| 宿主侧原生 guest ABI | `src/host/wasm-guest/wasm-guest-host.ts`（`WasmGuestHost`） |
| Rust guest SDK（future/executor/宏/typed 包装 + `ui`/`render`） | `crates/rill-guest/src/lib.rs` |
| 真 Rust guest：host:* 调用 / 渲染 | `crates/kv-guest/src/lib.rs`、`crates/ui-guest/src/lib.rs`、`crates/build.sh` |
| 最小原生 guest（wire 级 ABI，手写） | `src/host/wasm-guest/__tests__/fixtures/roundtrip.wat` |
| 往返 + 封口负向 + Rust guest + 渲染物化测试 | `src/host/wasm-guest/__tests__/wasm-guest-host.test.ts` |
| 渲染批次物化（复用） | `src/host/receiver/receiver.ts`（`applyBatch`）、`src/host/registry.ts` |
| 复用的能力派发 | `src/contract/index.ts`（`createHostModuleDispatch`） |
| 异步模型来源（现有 QuickJS 桥） | `src/host/sandbox/providers/quickjs-native-wasm-provider.ts` |
| JS guest 装载（本路径平行物） | `src/host/engine/engine.ts`（`loadBundle`/`evalCode`） |

---

**一句话**：② = 把 QuickJS 早就在用的那条底层 host↔WASM 桥，**抽成语言中立的线性内存 ABI**，供原生 `.wasm` 直接绑；因**派发/broker/渲染/信任全共享、只多一个 guest 侧适配器**，所以**加法式兼容、不动现有 QuickJS**。Phase A/B/C 已用真 Rust `.wasm` guest 把「装载 + host:* 往返 + 封口 + 渲染出 UI」端到端跑通。
