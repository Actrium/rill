# Native Platform Integration

This guide covers how to integrate the Rill native sandbox module into an iOS or macOS React Native project. The native module provides JSI-based sandbox engines (JSC, Hermes, QuickJS) that run guest bundles in full isolation on a dedicated thread.

---

## React Native Architecture Requirements

Rill's native layer depends on **JSI** and **TurboModules**:

- **JSI (JavaScript Interface)** -- The C++ interface that allows JavaScript and native code to call each other directly, without JSON serialization. Rill uses JSI to install the `RillTenantManager` HostObject and sandbox engine bindings into the RN JS runtime.
- **TurboModules** -- The native module system built on JSI. Rill exposes `RillSandboxNativeTurboModule` so the host RN app can create and manage sandbox instances (the second JS runtime) from JavaScript.

Rill does **not** depend on **Fabric** (the new rendering system). Guest UI is rendered through Rill's own reconciler-to-host bridge, not through Fabric's C++ renderer.

Rill requires React Native's **New Architecture (Bridgeless mode)**. Legacy Bridge is not supported.

---

## Installation

```bash
npm install rill
cd ios && pod install && cd ..
```

That's it. React Native autolinking detects `RillSandboxNative` and links it automatically. No manual Podfile changes or AppDelegate code required.

> Note: On macOS / `react-native-macos` 0.81.x + Hermes, there are known upstream build issues. rill applies compatibility fixes automatically during `npm install` and `pod install` (no manual patching required).  
> If your dependencies are read-only (common with Yarn PnP / zipfs), `pod install` will fail fast with actionable guidance; you can also set `RILL_SKIP_RN_MACOS_PATCH=1` to skip (at the cost of potentially hitting the upstream build issue).

### Sandbox Engine Selection

The default engine is **JSC** (JavaScriptCore). To use a different engine, set `RILL_SANDBOX_ENGINE` when running Pod install:

```bash
RILL_SANDBOX_ENGINE=hermes pod install
RILL_SANDBOX_ENGINE=quickjs pod install
```

| Value | Engine | Notes |
|---|---|---|
| `jsc` | JavaScriptCore | Default. Uses the system JSC framework. |
| `hermes` | Hermes | Reuses the Hermes binary already linked by React Native (requires Hermes enabled in the host; otherwise the build fails with a clear compiler error). |
| `quickjs` | QuickJS | Bundles a lightweight QuickJS static library (~200 KB). |

`RILL_SANDBOX_ENGINE` is a **compile-time only** setting. It controls which native source files and libraries are linked. After changing it, run `pod install` and perform a clean build.

---

## New Architecture (Bridgeless) -- Automatic Installation

On React Native's New Architecture (Bridgeless mode), the native module installs its JSI bindings automatically during runtime initialization. No additional code is required in your `AppDelegate`.

The module hooks into `RCTHost`'s `didInitializeRuntime:` callback and calls `RillSandboxNativeInstall` on the JS runtime.

### Optional Explicit Installation

If you need to control the installation timing, you can call the install function directly:

```objc
// AppDelegate.mm
#import <RillSandboxNative/RillSandboxNativeTurboModule.h>

- (void)didInitializeRuntime:(facebook::jsi::Runtime &)runtime {
  RillSandboxNativeInstall(&runtime);
}
```

This is only necessary in advanced scenarios where you need the sandbox available before other TurboModules initialize.

---

## Android Configuration

Android native integration is planned for a future release. The QuickJS Native provider will be the primary engine on Android, compiled via CMake and exposed through JSI in the same way as the Apple implementation.

---

## Troubleshooting

### "No native JSI sandbox module found"

This error means the JS layer attempted to use a native sandbox provider but the JSI binding was not installed.

**Steps to resolve:**

1. Verify that `RillSandboxNative` appears in your `Podfile.lock`. If it does not, check your `Podfile` and re-run `pod install`.
2. Open the Xcode build log and search for `RillSandboxNative`. You should see the pod's source files compiled during the build.
3. Clean the build folder (`Product > Clean Build Folder` in Xcode) and rebuild.

### Confirming Successful Installation

Look for this log line at launch:

```
[RillSandboxNative] Installed ... (source=RCTHost.instance:didInitializeRuntime:)
```

If this line does not appear, the native module was not linked correctly. Re-check the CocoaPods configuration above.

### Engine Mismatch

If you see an error about a missing engine symbol (for example, `Undefined symbol: _quickjs_...`), verify that the `RILL_SANDBOX_ENGINE` environment variable in your Podfile matches the engine you intend to use, then run `pod install` and clean build.
