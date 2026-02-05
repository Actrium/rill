# 原生平台集成

本指南介绍如何将 Rill 原生沙箱模块集成到 iOS 或 macOS React Native 项目中。原生模块提供基于 JSI 的沙箱引擎(JSC、Hermes、QuickJS),在专用线程上以完全隔离的方式运行 guest bundle。

---

## React Native 架构依赖

Rill 的原生层依赖 **JSI** 和 **TurboModules**:

- **JSI (JavaScript Interface)** -- C++ 接口,允许 JavaScript 和原生代码直接互调,无需 JSON 序列化。Rill 通过 JSI 将 `RillOrchestrator` HostObject 和沙箱引擎绑定安装到 RN 的 JS 运行时中。
- **TurboModules** -- 基于 JSI 的原生模块系统。Rill 通过 `RillSandboxNativeTurboModule` 让宿主 RN 应用从 JavaScript 端创建和管理沙箱实例(第二层 JS 运行时)。

Rill **不依赖** **Fabric**(新渲染系统)。Guest UI 通过 Rill 自有的 reconciler-to-host 桥接渲染,而非 Fabric 的 C++ 渲染器。

Rill 要求 React Native 的**新架构 (Bridgeless 模式)**。不支持旧版 Legacy Bridge。

---

## 安装

```bash
npm install rill
cd ios && pod install && cd ..
```

完成。React Native autolinking 会自动检测并链接 `RillSandboxNative`。无需手动修改 Podfile,也无需在 AppDelegate 中编写任何桥接代码。

> 说明：在 macOS / `react-native-macos` 0.81.x + Hermes 的组合下，存在已知上游编译问题。rill 会在 `npm install` 与 `pod install` 阶段自动应用兼容性修复（无需手动 patch）。  
> 如果你的依赖目录是只读（常见于 Yarn PnP / zipfs），`pod install` 会直接失败并给出修复建议；也可设置 `RILL_SKIP_RN_MACOS_PATCH=1` 跳过（但可能会遇到上游编译问题）。

### 沙箱引擎选择

默认引擎为 **JSC** (JavaScriptCore)。如需使用其他引擎,在运行 Pod install 时设置 `RILL_SANDBOX_ENGINE`:

```bash
RILL_SANDBOX_ENGINE=hermes pod install
RILL_SANDBOX_ENGINE=quickjs pod install
```

| 值 | 引擎 | 备注 |
|---|---|---|
| `jsc` | JavaScriptCore | 默认。使用系统 JSC 框架。 |
| `hermes` | Hermes | 重用 React Native 已链接的 Hermes 二进制文件（要求宿主也启用 Hermes，否则会在编译期报错）。 |
| `quickjs` | QuickJS | 打包一个轻量级的 QuickJS 静态库(~200 KB)。 |

`RILL_SANDBOX_ENGINE` 是一个**仅编译时**设置。它控制链接哪些原生源文件和库。更改后需重新运行 `pod install` 并执行清理构建。

---

## 新架构 (Bridgeless) -- 自动安装

在 React Native 的新架构(Bridgeless 模式)上,原生模块在运行时初始化期间自动安装其 JSI 绑定。您的 `AppDelegate` 中无需额外代码。

该模块挂钩到 `RCTHost` 的 `didInitializeRuntime:` 回调,并在 JS 运行时上调用 `RillSandboxNativeInstall`。

### 可选的显式安装

如果需要控制安装时机,可以直接调用安装函数:

```objc
// AppDelegate.mm
#import <RillSandboxNative/RillSandboxNativeTurboModule.h>

- (void)didInitializeRuntime:(facebook::jsi::Runtime &)runtime {
  RillSandboxNativeInstall(&runtime);
}
```

这仅在需要在其他 TurboModule 初始化之前使沙箱可用的高级场景中才有必要。

---

## Android 配置

Android 原生集成计划在未来版本中推出。QuickJS Native provider 将是 Android 上的主要引擎,通过 CMake 编译,并以与 Apple 实现相同的方式通过 JSI 公开。

---

## 故障排除

### "No native JSI sandbox module found"

此错误意味着 JS 层尝试使用原生沙箱 provider,但 JSI 绑定未安装。

**解决步骤:**

1. 验证 `RillSandboxNative` 出现在您的 `Podfile.lock` 中。如果没有,检查您的 `Podfile` 并重新运行 `pod install`。
2. 打开 Xcode 构建日志并搜索 `RillSandboxNative`。您应该在构建期间看到该 pod 的源文件被编译。
3. 清理构建文件夹(在 Xcode 中选择 `Product > Clean Build Folder`)并重新构建。

### 确认成功安装

在启动时查找此日志行:

```
[RillSandboxNative] Installed ... (source=RCTHost.instance:didInitializeRuntime:)
```

如果此行未出现,则原生模块未正确链接。重新检查上述 CocoaPods 配置。

### 引擎不匹配

如果看到有关缺少引擎符号的错误(例如,`Undefined symbol: _quickjs_...`),请验证 Podfile 中的 `RILL_SANDBOX_ENGINE` 环境变量与您打算使用的引擎匹配,然后运行 `pod install` 并清理构建。
