#include <android/log.h>
#include <jni.h>

#include "QuickJSSandboxJSI.h"

namespace {
constexpr const char *kTag = "RillSandboxNative";

void logInfo(const char *msg) { __android_log_print(ANDROID_LOG_INFO, kTag, "%s", msg); }
void logError(const char *msg) { __android_log_print(ANDROID_LOG_ERROR, kTag, "%s", msg); }
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_rill_sandbox_RillSandboxNativeModule_nativeInstall(JNIEnv *env, jclass, jlong runtimePtr) {
  (void)env;
  if (runtimePtr == 0) {
    logError("nativeInstall called with null runtime pointer");
    return;
  }

  auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(runtimePtr);
  try {
    if (runtime->global().hasProperty(*runtime, "__QuickJSSandboxJSI")) {
      logInfo("__QuickJSSandboxJSI already installed, skipping");
      return;
    }

    quickjs_sandbox::QuickJSSandboxModule::install(*runtime);
    logInfo("Installed __QuickJSSandboxJSI");
  } catch (const std::exception &e) {
    __android_log_print(ANDROID_LOG_ERROR, kTag, "Failed to install __QuickJSSandboxJSI: %s", e.what());
  } catch (...) {
    logError("Failed to install __QuickJSSandboxJSI: unknown exception");
  }
}
