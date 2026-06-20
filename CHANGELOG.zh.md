# 更新日志

本文件记录项目的所有重要变更。

## [Unreleased]

### 新功能

#### 多引擎沙箱支持
- **Hermes 沙箱引擎**：为使用 Hermes 运行时的 React Native 应用添加原生 Hermes 沙箱
  - 零额外包体积（复用应用的 Hermes 引擎）
  - 支持字节码预编译 `evalBytecode()` —— 跳过解析/编译，加速启动
  - 在 Podfile 中设置 `RILL_SANDBOX_ENGINE=hermes` 构建
- **QuickJS 沙箱引擎**：为跨平台支持添加原生 QuickJS 沙箱
  - 支持 iOS、Android、macOS、Windows
  - 约 200 KB 包体积开销
  - 在 Podfile 中设置 `RILL_SANDBOX_ENGINE=quickjs` 构建
- **JSC 沙箱引擎**：现有 JSC 沙箱已完成集成
  - 仅限 Apple 平台（iOS、macOS、tvOS、visionOS）
  - 零包体积开销（使用系统 JSC）

#### React Native 新架构支持
- **Bridgeless 模式**：完整支持 React Native 0.83+ 新架构
  - 运行时初始化时自动安装 JSI 绑定
  - 可在 `RCTHostRuntimeDelegate::didInitializeRuntime` 中手动调用 `RillSandboxNativeInstall(&runtime)`
- **双架构支持**：无缝支持 Bridge（旧架构）和 Bridgeless 两种模式
  - 自动检测和回退
  - 两种模式都失败时提供统一错误信息

#### 组件名全局变量
- Engine 现在将已注册的组件名作为全局变量注入沙箱
- 支持**变量模式** `h(View, ...)` 替代**字符串模式** `h('View', ...)`
- 编译时组件名校验
- `rill/cli build` 自动将 JSX 转换为变量模式

### 变更

#### SDK 重命名
- **破坏性变更**：Guest SDK 从 `rill/let` 重命名为 `rill/guest`
  - 更新导入：`import { View, Text } from 'rill/guest'`
  - 旧的 `rill/let` 路径已移除

#### 原生代码整合
- 将原生 TurboModule 整合到共享的 `native/core/` 目录
- 简化 podspec 结构，使用直接路径
- 移除已废弃的 Web Worker 沙箱（`e2e-sandbox-web` 测试已删除）

#### 构建系统
- Guest bundle 现通过 Babel 转译为 ES5，提升引擎兼容性
- 改进 Hermes 兼容性，正确处理语法转译

### 修复

- 修复 JSI HostObject 检测沙箱可用性的问题
- 修复 JS 重载时 RillSandboxNative JSI 重复安装的问题
- 修复 Engine 中 timer polyfills 注入顺序问题
- 正确传递 `RCT_NEW_ARCH_ENABLED` 标志到 podspec

### 文档

- 添加内部文档的英文版本：
  - `NATIVE_SANDBOX_INTEGRATION.md`
  - `GUEST_HOST_INTERACTION.md`
  - `SANDBOX_SOLUTIONS_COMPARISON.md`
- 更新 `SANDBOX_SOLUTIONS_COMPARISON` 包含全部 5 种 Provider
- 在 API 文档中添加 Hermes 字节码预编译说明
- 在运行时架构文档中说明组件名全局变量注入
- 更新 `DefaultProvider` 选择逻辑，添加 Hermes 优先级
- 更新 sandbox 选项值：`'vm'|'jsc'|'quickjs'|'wasm-quickjs'|'none'`
