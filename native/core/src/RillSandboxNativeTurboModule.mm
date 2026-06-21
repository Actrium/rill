#import "RillSandboxNativeTurboModule.h"
#include "RillTenantManager.h"

#include <atomic>
#include <exception>
#include <mutex>

// Forward declare sandbox install functions to avoid type conflicts
// QuickJS defines JSValue as a C struct, while React Native's RCTBridge.h
// forward declares it as an Objective-C class. Include sandbox headers
// in separate compilation units to avoid conflicts.
namespace quickjs_sandbox {
  void installQuickJSSandbox(facebook::jsi::Runtime &runtime);
}
namespace hermes_sandbox {
  void installHermesSandbox(facebook::jsi::Runtime &runtime);
}
namespace jsc_sandbox {
  void installJSCSandbox(facebook::jsi::Runtime &runtime);
}

#import <React/RCTBridgeModule.h>
#import <ReactCommon/RCTHost.h>
#import <ReactCommon/RCTTurboModule.h>
#import <ReactCommon/RCTTurboModuleWithJSIBindings.h>
#import <objc/runtime.h>
#import <objc/message.h>

// Global host runtime pointer — set by the RCTHost swizzle proxy when the
// JS runtime initialises.  Consumers (e.g. demo perf bridge) can read it
// via RillSandboxNativeGetHostRuntime(), which mirrors Android's
// reactContext.javaScriptContextHolder.get().
static std::atomic<facebook::jsi::Runtime *> gHostRuntime{nullptr};

facebook::jsi::Runtime *RillSandboxNativeGetHostRuntime() {
  return gHostRuntime.load(std::memory_order_acquire);
}

namespace {
std::mutex gInstallMutex;

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
static constexpr const char *kSandboxGlobalName = "__QuickJSSandboxJSI";
static constexpr const char *kSandboxEngineName = "QuickJS";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
static constexpr const char *kSandboxGlobalName = "__HermesSandboxJSI";
static constexpr const char *kSandboxEngineName = "Hermes";
#else
static constexpr const char *kSandboxGlobalName = "__JSCSandboxJSI";
static constexpr const char *kSandboxEngineName = "JSC";
#endif

static bool runtimeHasSandboxGlobal(facebook::jsi::Runtime &runtime) {
  try {
    return runtime.global().hasProperty(runtime, kSandboxGlobalName);
  } catch (...) {
    return false;
  }
}

static void installSandboxBindings(facebook::jsi::Runtime &runtime) {
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
  quickjs_sandbox::installQuickJSSandbox(runtime);
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
  hermes_sandbox::installHermesSandbox(runtime);
#else
  jsc_sandbox::installJSCSandbox(runtime);
#endif
}

static void ensureSandboxInstalled(facebook::jsi::Runtime *runtime,
                                  const char *source) {
  if (runtime == nullptr) {
    NSLog(@"[RillSandboxNative] ensureSandboxInstalled called with null runtime (source=%s)",
          source ? source : "unknown");
    return;
  }

  std::lock_guard<std::mutex> lock(gInstallMutex);

  if (runtimeHasSandboxGlobal(*runtime)) {
    NSLog(@"[RillSandboxNative] %s sandbox JSI already installed (source=%s, runtime=%p)",
          kSandboxEngineName, source ? source : "unknown", runtime);
    return;
  }

  try {
    installSandboxBindings(*runtime);
    NSLog(@"[RillSandboxNative] Installed %s sandbox JSI (source=%s, runtime=%p)",
          kSandboxEngineName, source ? source : "unknown", runtime);
  } catch (const std::exception &e) {
    NSLog(@"[RillSandboxNative] Failed to install %s sandbox (source=%s): %s",
          kSandboxEngineName, source ? source : "unknown", e.what());
  } catch (...) {
    NSLog(@"[RillSandboxNative] Failed to install %s sandbox (source=%s): unknown error",
          kSandboxEngineName, source ? source : "unknown");
  }
}
} // namespace

#pragma mark - Public C API for bridgeless mode

extern "C" {

/**
 * Install sandbox JSI bindings into the given runtime.
 * Call this from RCTHostRuntimeDelegate::didInitializeRuntime in bridgeless mode.
 */
void RillSandboxNativeInstall(facebook::jsi::Runtime *runtime) {
  ensureSandboxInstalled(runtime, "RillSandboxNativeInstall");
}

} // extern "C"

void RillSandboxNativeInstallWithTenantManager(
    facebook::jsi::Runtime *runtime,
    std::shared_ptr<facebook::react::CallInvoker> callInvoker) {
  ensureSandboxInstalled(runtime, "RillSandboxNativeInstallWithTenantManager");

  if (runtime && !runtime->global().hasProperty(*runtime, "__RillTenantManager")) {
    rill::tenant_manager::RillTenantManager::install(*runtime, std::move(callInvoker));
  }
}

#pragma mark - Runtime delegate proxy for +load swizzle

/**
 * Internal proxy that intercepts RCTHost's runtime initialization to auto-install
 * sandbox JSI bindings. Forwards all calls to the original delegate if present.
 */
@interface _RillRuntimeDelegateProxy : NSObject <RCTHostRuntimeDelegate>
@property (nonatomic, weak, nullable) id<RCTHostRuntimeDelegate> originalDelegate;
@end

@implementation _RillRuntimeDelegateProxy

- (void)host:(RCTHost *)host didInitializeRuntime:(facebook::jsi::Runtime &)runtime {
  ensureSandboxInstalled(&runtime, "+load/didInitializeRuntime");

  // Store for RillSandboxNativeGetHostRuntime() — iOS equivalent of
  // Android's reactContext.javaScriptContextHolder.
  gHostRuntime.store(&runtime, std::memory_order_release);

  if ([_originalDelegate respondsToSelector:@selector(host:didInitializeRuntime:)]) {
    [_originalDelegate host:host didInitializeRuntime:runtime];
  }
}

@end

#pragma mark - +load auto-install via RCTHost swizzle

static void _rill_swizzled_RCTHost_start(id self, SEL _cmd) {
  // Capture existing runtimeDelegate before start
  id<RCTHostRuntimeDelegate> existing = [self runtimeDelegate];

  // Only inject if no delegate is set, or if ours isn't already installed
  if (!existing || ![existing isKindOfClass:[_RillRuntimeDelegateProxy class]]) {
    _RillRuntimeDelegateProxy *proxy = [_RillRuntimeDelegateProxy new];
    proxy.originalDelegate = existing;
    [self setRuntimeDelegate:proxy];
    // Associate proxy to keep it alive for the lifetime of the RCTHost instance
    objc_setAssociatedObject(self, @selector(_rill_swizzled_RCTHost_start),
                             proxy, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  // Call original -[RCTHost start] (stored as _rill_original_start)
  SEL origSel = @selector(_rill_original_start);
  ((void (*)(id, SEL))objc_msgSend)(self, origSel);
}

__attribute__((constructor))
static void _rill_install_rcthost_swizzle(void) {
  Class hostClass = NSClassFromString(@"RCTHost");
  if (!hostClass) {
    return; // Not a React Native environment
  }

  SEL startSel = @selector(start);
  Method startMethod = class_getInstanceMethod(hostClass, startSel);
  if (!startMethod) {
    NSLog(@"[RillSandboxNative] RCTHost has no -start method; skipping swizzle");
    return;
  }

  // Add original implementation under a new selector
  SEL origSel = @selector(_rill_original_start);
  BOOL added = class_addMethod(hostClass, origSel,
                               method_getImplementation(startMethod),
                               method_getTypeEncoding(startMethod));
  if (!added) {
    NSLog(@"[RillSandboxNative] Failed to stash original -[RCTHost start]; skipping swizzle");
    return;
  }

  // Replace -start with our version
  method_setImplementation(startMethod, (IMP)_rill_swizzled_RCTHost_start);
  NSLog(@"[RillSandboxNative] Installed RCTHost.start swizzle for auto JSI binding");
}

#pragma mark - TurboModule

/**
 * Objective-C++ TurboModule for RCT module registration.
 *
 * Bridgeless (New Architecture) only:
 *   -installJSIBindingsWithRuntime:callInvoker: is called by TurboModuleManager
 *   during runtime initialization.
 */
@interface RillSandboxNative : NSObject <
    RCTBridgeModule,
    RCTTurboModule,
    RCTTurboModuleWithJSIBindings
    >
@end

@implementation RillSandboxNative

RCT_EXPORT_MODULE(RillSandboxNative)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  // No exported JS methods: we only rely on RCTTurboModuleWithJSIBindings for side-effect installation.
  return std::make_shared<facebook::react::ObjCTurboModule>(params);
}

- (void)installJSIBindingsWithRuntime:(facebook::jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<facebook::react::CallInvoker> &)callinvoker {
  // RN calls this during TurboModuleManager setup, after the JSI runtime is ready.
  // Also store the host runtime pointer so app-local perf tooling (ios-demo)
  // can synchronously access the host JSI runtime without relying on swizzles.
  gHostRuntime.store(&runtime, std::memory_order_release);
  RillSandboxNativeInstallWithTenantManager(&runtime, callinvoker);
}

@end
