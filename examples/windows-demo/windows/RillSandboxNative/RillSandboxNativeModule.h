#pragma once

// RillSandboxNativeModule — Windows TurboModule for rill sandbox engine
//
// Installs the compile-time selected sandbox JSI binding (QuickJS or Hermes)
// into the host runtime. Engine is chosen at build time via RILL_SANDBOX_ENGINE.

#include <NativeModules.h>
#include <winrt/Microsoft.ReactNative.h>
#include <SandboxEngineConfig.h>

namespace facebook::jsi { class Runtime; }

namespace winrt::RillDemo {

REACT_MODULE(RillSandboxNativeModule, L"RillSandboxNative")
struct RillSandboxNativeModule {

  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept;

  REACT_SYNC_METHOD(install)
  bool install() noexcept;

  REACT_SYNC_METHOD(getCompiledSandboxEngine)
  std::string getCompiledSandboxEngine() noexcept;

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
  REACT_SYNC_METHOD(testQuickJS)
  std::string testQuickJS() noexcept;

  REACT_SYNC_METHOD(testQuickJSLevel)
  std::string testQuickJSLevel(int level) noexcept;
#endif

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
  REACT_SYNC_METHOD(testHermesNAPI)
  std::string testHermesNAPI(int level) noexcept;
#endif

  // Performance methods
  REACT_SYNC_METHOD(getMemoryUsage)
  double getMemoryUsage() noexcept;

  REACT_SYNC_METHOD(measureJSIRTT)
  double measureJSIRTT(int iterations) noexcept;

  REACT_SYNC_METHOD(measureOpsPerSecond)
  double measureOpsPerSecond(int durationMs) noexcept;

  REACT_SYNC_METHOD(evalInSandbox)
  double evalInSandbox(std::string code, std::string engine) noexcept;

  REACT_SYNC_METHOD(evalBytecodeAsset)
  double evalBytecodeAsset(std::string path, std::string engine) noexcept;

  REACT_SYNC_METHOD(supportsBytecodeEval)
  bool supportsBytecodeEval(std::string engine) noexcept;

  REACT_SYNC_METHOD(runSandboxBenchmark)
  double runSandboxBenchmark(
      std::string code,
      std::string bytecodePath,
      std::string engine,
      int warmup,
      int iterations) noexcept;

private:
  winrt::Microsoft::ReactNative::ReactContext m_reactContext{nullptr};
  facebook::jsi::Runtime *m_runtime{nullptr};
  bool m_installed{false};
};

} // namespace winrt::RillDemo
