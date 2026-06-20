# Rill API 参考

Rill 是一个轻量级、无头、沙箱化的动态 UI 渲染引擎，用于 React Native。本文档提供了包导出的概述和详细 API 参考的链接。

## 包导出路径

| 导出路径 | 描述 |
|---|---|
| `rill/host` | Host 运行时：Engine、useEngineView |
| `rill/host/preset` | Host UI 工具：EngineView、DefaultComponents |
| `rill/guest` | Guest SDK：沙箱侧代码的组件、hooks、类型 |
| `rill/devtools` | 开发和调试工具（RuntimeCollector、CDP transport） |
| `rill/cli` | 用于编译 Guest bundles 的 CLI 构建工具 |

> `import ... from 'rill'` 被刻意禁用，请使用 `rill/host` 与 `rill/guest`。

## 模块概览

### Host 运行时（`rill/host`）

Host 运行时是 Rill 的核心。它管理沙箱生命周期、组件注册、指令处理与渲染。主要 API 为：

- **Engine** -- 创建和管理一个隔离的 JS 沙箱。加载 Guest bundles，处理双向通信，并拥有 Bridge、Receiver 和 CallbackRegistry。
- **useEngineView** -- 用于将 Engine 渲染进 React 树的 Host hook。

完整的 Host API 参考见 [host.zh.md](./host.zh.md)。

### Host Preset（`rill/host/preset`）

更偏“开箱即用”的 Host UI 工具：

- **EngineView** -- 对 Engine + useEngineView 的声明式封装。
- **DefaultComponents** -- 常见 React Native 原语的默认 Host 组件映射。

### Guest（`rill/guest`）

Guest SDK 提供了沙箱内部可用的组件、hooks 和平台 API。Guest 代码使用标准 React 模式（JSX、hooks）并通过定义良好的协议与 Host 通信。

- **组件** -- View、Text、Image、TouchableOpacity、ScrollView、FlatList、TextInput、Button、Switch、ActivityIndicator。
- **Hooks** -- useConfig、useHostEvent、useSendToHost、useRemoteRef。
- **平台 API** -- Platform、Dimensions、StyleSheet、Linking。

完整的 Guest API 参考见 [guest.zh.md](./guest.zh.md)。

### TenantManager（使用 `sandbox: 'tenant-manager'` 的 `rill/host`）

TenantManager 是一个通过 JSI 暴露给 Host JS 运行时的原生 C++ 多租户沙箱管理器。它提供了租户生命周期管理、每租户资源配额、权限强制执行和跨租户 EventBus。

- **注意：**不需要导入 provider。`Engine` 会自动检测 `globalThis.__RillTenantManager` 并在内部委托给 TenantManager；或者你也可以通过 `EngineOptions.sandbox = 'tenant-manager'` 强制启用。
- **RillTenantManagerJSI** -- 用于租户管理、代码加载、通信、指标和 EventBus 操作的完整 JSI 接口。

完整的 TenantManager API 参考见 [tenant manager.zh.md](./tenant manager.zh.md)。

### 沙箱提供者（内部）

沙箱提供者实现了 `JSEngineProvider` 接口，但它们属于内部实现（不再以 `rill/sandbox*` 的形式对外导出）。

请使用 `EngineOptions.sandbox` 来选择引擎后端。

| 后端 | 平台 | 隔离 | 备注 |
|---|---|---|---|
| `vm` | Node.js / Bun | 进程级 | 服务器/测试环境的默认选择 |
| `jsc` | Apple（iOS/macOS） | JSI 原生 | 通过 JSI 的 JavaScriptCore |
| `hermes` | React Native | JSI 原生 | 通过 JSI 的 Hermes 沙箱 |
| `quickjs` | 跨平台 | JSI 原生 | 通过 JSI 的 QuickJS |
| `wasm-quickjs` | Web / React Native | WASM | 编译为 WebAssembly 的 QuickJS |
| `tenant manager` | Apple（iOS/macOS） | 原生 C++ | 带专用线程的多租户 |

### DevTools（`rill/devtools`）

用于检查沙箱状态、组件树、控制台输出和性能指标的开发工具。支持用于远程调试的 Chrome DevTools Protocol（CDP）transport。

### CLI（`rill/cli`）

用于将 Guest 源代码编译为适合沙箱执行的优化 bundles 的构建工具。处理 JSX 转换、模块解析和 tree-shaking。
