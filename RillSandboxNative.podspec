require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Sandbox engine selection: 'jsc' (default), 'hermes', or 'quickjs'
sandbox_engine = ENV['RILL_SANDBOX_ENGINE'] || 'jsc'

Pod::Spec.new do |s|
  s.name         = "RillSandboxNative"
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['homepage'] || "https://github.com/GoAskAway/rill"
  s.license      = package['license'] || "Apache-2.0"
  s.authors      = package['authors'] || { "Rill Team" => "team@rill.dev" }
  s.platforms    = { :ios => "13.0", :osx => "10.15", :tvos => "13.0", :visionos => "1.0" }
  s.source       = { :git => package['repository'] || "https://github.com/GoAskAway/rill.git", :tag => "v#{s.version}" }
  # CocoaPods executes `prepare_command` during `pod install`.
  #
  # We use it as a safety net to apply known `react-native-macos` 0.81.x fixes even when:
  #   - npm/yarn/pnpm skips dependency lifecycle scripts (e.g. `file:` / workspace links)
  #   - project installs with `--ignore-scripts`
  #
  # IMPORTANT:
  #   - Default behavior is fail-fast during `pod install` when we detect a known
  #     react-native-macos 0.81.x issue that we cannot auto-fix (for example, a
  #     read-only dependency layout under Yarn PnP/zipfs).
  #   - To skip this check/patch, set: RILL_SKIP_RN_MACOS_PATCH=1
  s.prepare_command = <<~CMD
    if command -v node >/dev/null 2>&1; then
      RILL_RN_MACOS_PATCH_STRICT=1 node scripts/rill_postinstall.js
    fi
  CMD

  # Common source files: TurboModule entry + TenantManager infrastructure
  common_sources = [
    "native/core/src/SandboxEngineConfig.h",
    "native/core/src/RillSandboxNativeTurboModule.{h,mm}",
    "native/core/src/RillTenantManager.{h,mm}",
    "native/core/src/TenantHandle.{h,cpp}",
    "native/core/src/TimerWheel.{h,cpp}",
    "native/core/src/TenantThread.{h,cpp}",
    "native/core/src/ThreadPool.{h,cpp}",
    "native/core/src/TenantContext.{h,cpp}",
    "native/core/src/TenantRegistry.{h,cpp}",
    "native/core/src/EventBus.{h,cpp}",
    "native/core/src/security/*.{h,cpp}",
    "native/core/src/devtools/*.{h,cpp}",
    "native/core/src/devtools/CDPTransportApple.{h,mm}"
  ]

  # Engine-specific source files
  if sandbox_engine == 'quickjs'
    s.source_files = common_sources + [
      "native/quickjs/src/*.{h,cpp}",
      "native/quickjs/vendor/*.{h,c}"
    ]
    s.exclude_files = [
      "native/quickjs/src/EmscriptenBindings.cpp",
      "native/quickjs/src/wasm_bindings.c"
    ]
    s.public_header_files = [
      "native/core/src/SandboxEngineConfig.h",
      "native/core/src/RillSandboxNativeTurboModule.h",
      "native/core/src/RillTenantManager.h",
      "native/quickjs/src/*.h",
      "native/quickjs/vendor/*.h"
    ]
  elsif sandbox_engine == 'hermes'
    s.source_files = common_sources + [
      "native/hermes/src/HermesSandboxJSI.{h,cpp}",
      # CDP DevTools relay for guest debugging. Whole TU is gated on
      # RILL_WIP_CDP_DEVTOOLS && !NDEBUG, so it compiles to nothing unless the
      # dev flag is on (see the ENV opt-in below).
      "native/hermes/src/devtools/*.{h,cpp}"
    ]
    s.public_header_files = [
      "native/core/src/SandboxEngineConfig.h",
      "native/core/src/RillSandboxNativeTurboModule.h",
      "native/core/src/RillTenantManager.h",
      "native/hermes/src/HermesSandboxJSI.h"
    ]
    # Hermes sandbox needs hermes-engine from React Native (not CocoaPods trunk which is outdated 0.11.0)
    # The app's Podfile must either:
    # 1. Enable Hermes as main runtime (:hermes_enabled => true), or
    # 2. Manually add: pod 'hermes-engine', :path => "#{react_native_path}/sdks/hermes-engine"
  else
    # Default: JSC sandbox
    s.source_files = common_sources + [
      "native/jsc/src/**/*.{h,mm}"
    ]
    s.public_header_files = [
      "native/core/src/SandboxEngineConfig.h",
      "native/core/src/RillSandboxNativeTurboModule.h",
      "native/core/src/RillTenantManager.h",
      "native/jsc/src/**/*.h"
    ]
  end
  s.static_framework = true
  s.requires_arc = true

  s.dependency "React-jsi"
  s.dependency "React-callinvoker"
  s.dependency "React-Core"
  s.dependency "React-NativeModulesApple"
  s.dependency "React-RuntimeApple"

  frameworks = ["Network"]
  # JSC sandbox directly links against JavaScriptCore.framework.
  frameworks << "JavaScriptCore" if sandbox_engine == 'jsc'
  s.frameworks = frameworks

  preprocessor_defs = '$(inherited) RCT_NEW_ARCH_ENABLED=1'
  preprocessor_defs += ' FOLLY_NO_CONFIG=1 FOLLY_MOBILE=1 FOLLY_USE_LIBCPP=1 FOLLY_CFG_NO_COROUTINES=1 FOLLY_HAVE_CLOCK_GETTIME=1'

  if sandbox_engine == 'quickjs'
    preprocessor_defs += ' RILL_SANDBOX_ENGINE=3'
  elsif sandbox_engine == 'hermes'
    preprocessor_defs += ' RILL_SANDBOX_ENGINE=2'
  else
    preprocessor_defs += ' RILL_SANDBOX_ENGINE=1'
  end

  # Dev-only: opt JSC sandbox contexts into Apple's Remote Inspector (Safari Web
  # Inspector) when explicitly requested via ENV. The code path is ALSO gated on
  # !NDEBUG, so a Release archive strips it even if this define leaks in — never
  # ship an inspectable sandbox. Only meaningful for sandbox_engine == 'jsc'.
  preprocessor_defs += ' RILL_WIP_JSC_INSPECTOR=1' if ENV['RILL_WIP_JSC_INSPECTOR'] == '1'

  # Dev-only: opt Hermes sandbox tenants into the CDP DevTools relay (guest
  # debugging over Chrome DevTools Protocol) when explicitly requested via ENV.
  # Also gated on !NDEBUG, so a Release archive strips it even if this define
  # leaks in. HERMES_ENABLE_DEBUGGER is paired in so our TUs bind the real
  # cdp::CDPAgent / AsyncDebuggerAPI (a debug Hermes build ships them); never
  # ship an inspectable sandbox. Only meaningful for sandbox_engine == 'hermes'.
  if ENV['RILL_WIP_CDP_DEVTOOLS'] == '1'
    preprocessor_defs += ' RILL_WIP_CDP_DEVTOOLS=1 HERMES_ENABLE_DEBUGGER=1'
  end

  s.pod_target_xcconfig = {
    'GCC_PREPROCESSOR_DEFINITIONS' => preprocessor_defs,
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    # native/core/src on the path lets the Hermes CDP relay resolve its
    # cross-module quoted includes ("devtools/CdpDebuggable.h",
    # "devtools/EngineDebugTarget.h") when RILL_WIP_CDP_DEVTOOLS is on.
    'HEADER_SEARCH_PATHS' => '$(inherited) $(PODS_ROOT)/Headers/Public/ReactCommon $(PODS_ROOT)/Headers/Private/ReactCommon $(PODS_ROOT)/Headers/Public/React-RuntimeApple $(PODS_TARGET_SRCROOT)/native/core/src $(PODS_TARGET_SRCROOT)/native/hermes/src'
  }
end
