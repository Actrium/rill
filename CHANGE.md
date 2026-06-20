# Android Host -> Guest / Microtask 修复记录

## 结论

`fix/some` 现在按 `main` 的最新 Bridge 架构处理 Host -> Guest 消息：

1. Host 调用 `Engine.sendEvent()` 或 `sendToSandbox()`
2. `Bridge.sendToGuest()` 完成 HostMessage 编解码
3. Engine 将消息注入 `globalThis.__hostMessage`
4. Engine 通过 `evalCode('globalThis.__rill_handleMessage(__hostMessage)')` 在 Guest runtime 内执行分发
5. Guest 侧 `__rill.dispatchEvent()` 调用 `useHostEvent()` 注册的 listener

因此旧分支里直接引入 `__rillUseHostEvent` / `__rillHandleHostEvent` 的方案不再是当前最佳路径。当前架构已经避免了从 Host 直接调用 Guest function shell 的问题，真正需要补齐的是各 native sandbox adapter 在 `eval()` 和跨 runtime 函数调用后的调度语义。

## Bug 本质

Android QuickJS 的 `JS_Eval()` 成功执行同步代码后，不会自动执行 pending jobs。`Promise.resolve().then(...)` 这类 microtask 会留在 QuickJS runtime 队列里。

Host -> Guest event 的 listener 可以被同步调用，但 listener 内部或 React 调度链路里排入的 Promise microtask 不会及时执行，表现为：

- `.then()` 不触发
- 状态更新或后续回调没有落地
- Android QuickJS 与 JSC/Hermes 行为不一致

继续跑 Android emulator E2E 后，还发现 Hermes JSI adapter 存在同类缺口：隔离 Hermes runtime 没有基础 `setImmediate` / `queueMicrotask` shim，且 `eval()` 后没有显式 drain。React/RN scheduler 或 Promise 链路触发 `setImmediate` 时会报 `Property 'setImmediate' doesn't exist`。

这不是业务协议问题，而是 sandbox adapter 没有完整承担“宿主事件循环 checkpoint”的职责：同步 `eval()` 返回前必须把本 runtime 内已经排入的 microtask/immediate 队列推进到稳定状态。

## 过程慢的原因

实测慢主要不是测试断言本身，而是 runner 有重复和卡死点：

- 本机工作区存在大量 macOS `compressed,dataless` 文件，表现为 `stat` 大小正常但读取为 0 字节或阻塞。受影响文件包括 `package-lock.json`、`src/sdk/sdk.ts`、`src/cli/oxc-adapter.js`、QuickJS WASM、Biome/Playwright/React/oxc native binding 等。结果是 `bun install` 卡在 resolving、`git status`/`rg`/Metro 扫描变慢、Node/Bun `require()` 返回空导出或 native binary `ENOEXEC`
- `examples/android-demo/install.sh` 先手动执行一次 Metro bundle，Gradle release 构建的 React Native task 又会再 bundle 一次
- 前置 `react-native/cli.js bundle` 在连续 quickjs/hermes 两个 flavor 时出现 Node/Jest worker 不退出，表现为长时间无输出
- 首次 Android release 构建还要生成 CMake/NDK、Metro、dex、APK 产物，`examples/android-demo/android/app/build` 会增长到 GB 级，冷构建天然慢
- 早期动态 autolinking 会经由 `file:` dependency 扫到 repo 根和 native build artifacts，进一步放大卡顿
- Android demo 的 Metro `watchFolders` 指向 rill symlink realpath 后，若未显式关闭 `resolver.useWatchman`，Watchman 会尝试解析 repo 根并触发 `Resource deadlock avoided`；若未 block 根 `node_modules`，Metro 还会扫到根依赖里的 dataless `package.json`
- 原 `bun test`/coverage 默认会触发仓库级发现和覆盖率扫描，遇到 GB 级 native/Android 生成物和 dataless 文件时非常慢；全量 unit 应改为显式测试文件列表

修复后 Android runner 默认跳过前置 bundle，只让 Gradle/RN 官方 task 负责把 JS bundle 打进 APK；热缓存下完整 quickjs+hermes emulator E2E 已能在几十秒内完成。

## 修复

- `native/quickjs/src/QuickJSSandboxJSI.cpp`
  - `QuickJSSandboxContext::eval()` 在成功 `JS_Eval()` 后循环调用 `JS_ExecutePendingJob()`
  - 队列为空时返回
  - pending job 抛错时转成 `jsi::JSError`
  - 超过安全阈值时报错，避免无限 drain

- `native/hermes/src/HermesSandboxJSI.cpp`
  - sandbox runtime 初始化时注入基础 `queueMicrotask` / `setImmediate` / `clearImmediate` shim
  - `eval()` / `evalBytecode()` 后循环调用 Hermes `drainMicrotasks()` 并 drain 内部 immediate 队列
  - Host 调用 Guest function 返回前同样 drain，覆盖 Guest function 内部排 Promise/Immediate 的情况
  - 保留安全阈值，避免无限调度循环

- `native/quickjs/test/sandbox_test.js`
  - 新增精确回归断言：`ctx.eval('Promise.resolve(42).then(...)')` 后立即 `ctx.extract()` 必须看到 microtask 已执行
  - 旧实现会失败，修复后通过

- `examples/android-demo/App.tsx`
  - Android emulator E2E 增加同一组真实设备/模拟器断言
  - QuickJS/Hermes flavor 都会跑到该检查

- Android/iOS demo runner 稳定性
  - Android demo 使用静态 autolinking，避免 RN CLI 扫描 repo 生成物卡住
  - Metro 关闭 Watchman，block rill 根 `node_modules` 和 native/test build artifacts
  - Android install 默认跳过手动 pre-bundle，避免与 Gradle React Native bundle task 重复
  - Android Gradle 降并发、增加 HTTP timeout、禁 release lint 阻断
  - iOS/Android runner 明确选择 Node 22，限制 Metro/Xcode/Gradle 并发

- 本机测试/工具链稳定性
  - 恢复 dataless 的 tracked 源文件和测试 fixture，避免 Git/Metro/编译器读到空内容
  - 重铺本机损坏的 `react` / `react-test-renderer` / `oxc-parser` / `@biomejs` / `playwright` 依赖内容
  - `bunfig.toml` 默认关闭 coverage；新增 `scripts/run-unit-tests.sh`，只收集 `src` 下测试文件并传给 Bun
  - `src/cli/build.ts` 延迟加载 Babel，并在无 `host:`/`export` 代码时跳过 Host boundary 深扫
  - `src/host/__tests__/setup.ts` 不再默认加载 `happy-dom`，避免 Bun 在非 DOM 测试中触发 `ECANCELED`

## 验证范围

本轮在 `fix/some` 上已通过：

- `bun run preflight`
- `bun run test:native`
- `bun run test:bundle`
- `bun run test:e2e:wasm`
- `RILL_ANDROID_E2E_AVD=Pixel_API_35 bun run test:e2e:android-emulator`

未在本轮重新声明通过：

- `bun run test:e2e:rn`
- `bun run test:e2e:ios-sim`
