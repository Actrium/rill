# 原生-guest 线的 defer 项设计留档

> 承 [native-guest.zh.md](native-guest.zh.md)。活跃集（事件 / 共存 / C SDK / fuzz）已落地；本文给**当前刻意 defer 的四项**留下设计与触发条件——不是不做，是排在后面、按条件启动。定序理由见该轮 workflow：多数项改同一批核心文件（`crates/rill-guest/src/lib.rs`、`src/host/wasm-guest/wasm-guest-host.ts`、共享测试文件），必须串行；且 #1/#6 大而险，应等 API 面稳定后再动。

---

## #1 · 批次/值 wire 换二进制 op 协议（零拷贝终局）

**目标**：把原生 guest 的 wire 从 JSON 换成 rill 现有的二进制 op 协议（`BinaryProtocol`），与 JS guest 完全一致、高频优化、零拷贝。

**现状（grounded）**：
- JS guest 已用二进制协议：`src/shared/bridge/binary-protocol.ts`（`BinaryEncoder`/`BinaryDecoder`；`RILL_MAGIC=0x4c4c4952`、`PROTOCOL_VERSION=1`；op 码 `0x01–0x09`、value 类型 `0x00–0x0f`；16 字节 header + 字符串驻留表；`MAX_INTERN_STRINGS=65535`）。
- 原生 guest 现在走 JSON：guest 侧 `crates/rill-guest/src/lib.rs` 的 `render()` 用 `format!` 拼 JSON；host 侧 `wasm-guest-host.ts` 的 `onSendBatch`/`onHostCall` 用 `JSON.parse`。

**设计**：
- **guest 侧**：新增 `crates/rill-guest/src/binary.rs`，一个 no_std 二进制编码器，**逐字节对齐** `binary-encoder.ts`（op/value 类型码、u8/u16/u32/f64 小端、header、驻留表用 `Vec` 线性查找——典型批次 <100 串）。`render()` 改调它而非拼 JSON。
- **host 侧**：`onSendBatch` 把 `JSON.parse` 换成 `BinaryProtocol.decodeBatch(this.readBytes(ptr,len))`——`BinaryDecoder` 已能按 `RILL_MAGIC` 自动识别 `ArrayBuffer` 并解成 `OperationBatch`。value/host:* 字节也可同法零拷贝。
- **兼容**：JSON 保留为回退；host 用 `detectPayloadEncoding` 同时接受二者，灰度切换。

**风险**：**格式逐字节 parity**——字段宽度（header 16 字节、串长 u16 vs u32）差一位，host 解码就静默坏。缓解：紧测试环（round-trip / 压缩率 / 对抗畸形二进制）+ 对着 `binary-protocol.ts` 常量手工核。冲突文件：`wasm-guest-host.ts` + 其测试 + `lib.rs`（**三大热文件全占，绝不能与 #2/#5/#8 并行**）。

**触发条件**：ABI + 事件 + C SDK 稳定后，且带 round-trip/对抗/压缩基准；保留 JSON 回退。**effort M**。收益：二进制体积约 JSON 的 ~60%、编码 3–5× 提速（`binary-protocol.ts` 基准）。

---

## #2 · rill_on_event —— **已落地**（见 native-guest.zh.md §6），此处不再 defer。

---

## #3 · rill CLI 加原生 `.wasm` guest 构建目标

**目标**：让 rill CLI 能产出/打包原生 guest（现在只出 JS bundle；原生 guest 靠 `crates/build.sh` / `sdk/c/build.sh` 手工编）。

**现状（grounded）**：`src/cli/build.ts` 只构建 JS guest bundle（+ `src/cli/bin.ts` 入口）。原生 guest 的 `.wasm` 目前是**测试 fixture**，非 CLI 产物。

**设计（两条路，需拍板）**：
- **Path A · CLI 调 cargo/clang**：CLI 直接编译原生 guest 源 → `.wasm`。集成度高但把 Rust/C 工具链耦进 CLI（重）。
- **Path B · 打包预编译 `.wasm`（推荐先做）**：CLI 接受一个**已编好的 `.wasm`**，校验其 import ⊆ `{rill_host_call, rill_send_batch, rill_log, rill_on_event}`（复用封口不变量），写 `manifest.runtime="wasm"`。低风险、无工具链耦合。

**依赖/阻塞**：需 **下游平台仓侧先加 `manifest.runtime: "js" | "wasm"` 字段 + 分发/装载时按之分流**（平台侧改动，不在 rill 仓）。所以本项**卡在上游决策**。文件 `src/cli/{build,bin}.ts` 与其它项**不相交**，capacity 允许时 Path B 可随任意波并行。

**触发条件**：下游平台仓定了 `runtime` 字段 + 装载分流后，做 Path B。**effort M**。

---

## #4 · host:* typed 包装的**模式**（不是硬塞能力）

**目标**：给 guest 作者一套人体工学的 typed host:* 包装，别只有裸 `host_call` + 手拼 JSON。

**现状（grounded）**：`crates/rill-guest/src/lib.rs` 有通用 `host_call` + 一个 `host:store` demo（`store::put/get`，手拼 JSON，wire 对齐平台 host-store.ts 的 putText/getText）。**ABI 无需改**。

**关键定性（核实后）**：app 专属能力（`host:net`/`identity`/`billing`）住在**下游平台仓**，不在 rill 框架——**框架 SDK 不该硬编码它们**。所以本项是「选抽象」，不是「加能力」：
- **推荐 · Tier 2 代码生成**：从 `src/contract/index.ts` 的契约定义**生成** typed Rust 包装（TS→Rust codegen），app 作者按自己的契约生成自己的 SDK。
- **可选 · proc-macro**：Rust 宏从 schema 生成包装（更 Rust 原生，但增依赖）。
- **纪律**：framework 里只放**通用**helper（编解码/错误映射），保持 no_std + 最小体积；app 专属留 app SDK。

**风险**：低（无 ABI 改动）；主要是别把 app 能力泄进框架。冲突文件：`lib.rs`（与 #1/#2 冲突，不可并行）。

**触发条件**：有第二个真实 app 契约要复用时启动（现在一个 demo 不足以定型抽象）。**effort M**。先产出「SDK-pattern 文档 + 一个 TS→Rust codegen 的 mock」。

---

## #6 · 把 QuickJS 统一到线性内存 ABI（终局收成一条边界）

**目标**：现有 QuickJS 路径也改用原生 guest 的线性内存 ABI，host↔guest 只剩一条边界（呼应「先兼容、后重构求最优」的后半段）。

**现状（grounded）**：`src/host/sandbox/providers/quickjs-native-wasm-provider.ts` 用 **Emscripten 值桥**——`__sendToHost` + `__rill_fn_ret` + `__rill.callbacks`（同步 post + callback-resolve，JS 值形态）。原生 ABI 是线性内存 `ptr+len`。

**设计**：把 QuickJS provider 的 host-call 桥从「JS 值 ccall/cwrap」重构成「线性内存 `rill_host_call`/`rill_resolve`」，与 `WasmGuestHost` 收成同一套派发/编解码。

**风险（最高，明确 defer）**：
- QuickJS 是**生产默认引擎**；重构改**核心控制流**（同步 host-fn 注入 → 异步 callback-resolve），需在 C/QuickJS 侧加异步 executor，且**必须保留 timer pause/resume 的时钟冻结语义**。
- 回归面大（约 **797 行**相关测试）。
- 文件与活跃簇**不相交**（quickjs provider + 其测试），理论上可单独 worktree——但**风险/回归 + compat-first** 说：等。
- **关键**：一旦 QuickJS guest 以**外部产物**分发，ABI 就永久版本化——趁还只内部用，defer 保留改的自由。

**触发条件**：ABI 经原生 guest 充分验证稳定 + 先出**设计 + baseline 性能测量**，再实现；在 QuickJS 仍是生产默认期间**只设计不实现**。**effort L**。

---

## 一句话

四项都排在活跃集之后：**#1 二进制 wire** 等 API 面稳、一次换 wire（保 JSON 回退）；**#3 CLI** 卡下游平台仓的 `runtime` 字段，解锁后先做低风险 Path B；**#4 typed 宏** 等第二个真实契约再定抽象、且只放通用 helper；**#6 QuickJS 统一** 最险，先设计+测基准、ABI 证稳且 QuickJS 非生产默认时再动。定序主线始终是：**只在已上线主路径花钱、内部边界可安全重构、不为预期未来预造抽象。**
