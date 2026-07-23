# 原生 guest 源码级调试(Wasm-V8)

面向:调试**原生 Rust→wasm guest**(`crates/*-guest`,经 `WebAssembly.instantiate` 跑在浏览器 V8 里的那种 guest)。

## 原理

浏览器 V8 自带完整、支持 wasm **DWARF** 的调试能力;Chrome DevTools 装上「**C/C++ DevTools Support (DWARF)**」扩展后,能把 wasm 的机器地址映射回 **Rust 源码**,支持下断点、单步、看局部变量。rill 侧**不写任何调试器代码**——只要把带 DWARF 的 guest 交给 V8,DevTools 就能接管。

> 注意区分两种 web guest:本文只适用于**直接 wasm 的 Rust guest**。「wasm 里跑 QuickJS、业务用 JS」那种 guest,V8 只看得见 QuickJS 解释器本身、看不见里面的业务 JS——那条路要另一套机制(QuickJS 行级钩子 + asyncify),不在本文范围。

## 为什么不能直接用出货 fixture

出货的 release fixture(`src/host/wasm-guest/__tests__/fixtures/*.wasm`)是**字节可复现、且刻意不带 DWARF** 的:带上会让体积暴涨数百 KiB(调试版约 7× 大)、并泄漏构建机的**绝对源码路径**。所以 DWARF 只存在于一次性的 `crates/debug-artifacts/`,**永不提交**。

这条边界由测试 `src/host/wasm-guest/__tests__/wasm-guest-dwarf.test.ts` 守卫:断言每个 fixture 都无 `.debug_*` 自定义段。

## 步骤

**1. 构建带 DWARF 的调试 guest**

```bash
RILL_GUEST_DEBUG=1 crates/build.sh
```

产物在 `crates/debug-artifacts/*.wasm`(已 gitignore)。它用 `[profile.debug-wasm]`(`debug=2`、`strip=none`、`opt-level=1`、无 LTO),且**不加** `--remap-path-prefix`,保留真实源路径供 DevTools 定位。

**2. 让宿主加载调试 guest**

把宿主指向 `crates/debug-artifacts/<guest>.wasm` 而非出货 fixture(例如测试/示例里替换传给 `WasmGuestHost` 的 `wasmBinary`/`wasmPath`)。**v1 建议挂在主线程**上跑——Worker target 的 attach 更繁琐,后续再做。

**3. 用 Chrome DevTools 接上**

- Chrome 安装扩展「C/C++ DevTools Support (DWARF)」。
- 打开承载 guest 的页面的 DevTools → Sources,应能看到 wasm 模块被解析为 Rust 源文件。
- 在 `.rs` 源上下断点,触发 guest 执行即命中,可单步、看调用栈与作用域。

## 已知局限

- **opt-level=1 有损**:内联/优化会让部分局部变量显示为 `optimized out`,行信息偶有跳动。要最高保真可临时把 `[profile.debug-wasm]` 的 `opt-level` 降到 `0`(体积更大、更慢,但变量最全)。
- **体积**:调试 guest ~1 MB(release 版数十~百 KiB 级),仅供本地调试,**绝不提交、绝不出货**。
- **扩展依赖**:源码级映射依赖开发者自装的 Chrome DWARF 扩展;不装只能看反汇编。
- 本机若要查看 wasm 段/DWARF:`wasm-tools objdump <file> | grep debug`(`wasm-objdump`/`llvm-dwarfdump` 亦可,视本机安装)。
