#ifndef RILL_SANDBOX_NATIVE_TURBO_MODULE_H
#define RILL_SANDBOX_NATIVE_TURBO_MODULE_H

#include <jsi/jsi.h>
#include <ReactCommon/CallInvoker.h>

// Engine constants / selection (no RN includes).
#include "SandboxEngineConfig.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Install sandbox JSI bindings into the given runtime.
 * Call this from a platform entrypoint that has access to the JSI runtime.
 *
 * The sandbox engine (JSC or Hermes) is determined by RILL_SANDBOX_ENGINE at compile time.
 */
/// Install sandbox bindings only (no Orchestrator).
void RillSandboxNativeInstall(facebook::jsi::Runtime *runtime);

#ifdef __cplusplus
}

/// Install sandbox bindings AND the Orchestrator HostObject.
/// Preferred entry point — provides CallInvoker for Orchestrator scheduling.
void RillSandboxNativeInstallWithOrchestrator(
    facebook::jsi::Runtime *runtime,
    std::shared_ptr<facebook::react::CallInvoker> callInvoker);

/// Returns the host JSI runtime pointer, or nullptr if not yet initialised.
/// Set automatically by the RCTHost swizzle when the JS runtime starts.
/// iOS equivalent of Android's reactContext.javaScriptContextHolder.get().
facebook::jsi::Runtime *RillSandboxNativeGetHostRuntime();
#endif

#endif // RILL_SANDBOX_NATIVE_TURBO_MODULE_H
