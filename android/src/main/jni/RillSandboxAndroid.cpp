#include <jni.h>
#include <jsi/jsi.h>
#include <android/log.h>
#include <string>

#include "HermesSandboxJSI.h"
#include "QuickJSSandboxJSI.h"

#define LOG_TAG "RillSandboxNative"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static std::string jstringToStdString(JNIEnv *env, jstring value) {
  if (!value) return {};
  const char *chars = env->GetStringUTFChars(value, nullptr);
  std::string out = chars ? std::string(chars) : std::string();
  if (chars) env->ReleaseStringUTFChars(value, chars);
  return out;
}

extern "C" JNIEXPORT void JNICALL
Java_com_rill_sandbox_RillSandboxNativeModule_nativeInstallEngine(
    JNIEnv *env, jclass clazz, jlong jsiRuntimeRef, jstring jEngine) {
  (void)clazz;

  if (jsiRuntimeRef == 0) {
    LOGE("nativeInstallEngine: jsiRuntimeRef is null");
    return;
  }

  const std::string engine = jstringToStdString(env, jEngine);

  bool shouldInstallHermes = true;
  bool shouldInstallQuickJS = true;

  if (engine == "hermes") {
    shouldInstallQuickJS = false;
  } else if (engine == "quickjs") {
    shouldInstallHermes = false;
  } else if (engine.empty() || engine == "all" || engine == "both") {
    // default: install both (previous behavior)
  } else {
    LOGE("nativeInstallEngine: unknown engine '%s' (installing all)", engine.c_str());
  }

  auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(jsiRuntimeRef);

  if (shouldInstallHermes) {
    LOGI("Installing Hermes sandbox JSI bindings...");
    try {
      hermes_sandbox::installHermesSandbox(*runtime);
      LOGI("Hermes sandbox JSI bindings installed successfully");
    } catch (const std::exception &e) {
      LOGE("Failed to install Hermes sandbox: %s", e.what());
    }
  }

  if (shouldInstallQuickJS) {
    LOGI("Installing QuickJS sandbox JSI bindings...");
    try {
      quickjs_sandbox::QuickJSSandboxModule::install(*runtime);
      LOGI("QuickJS sandbox JSI bindings installed successfully");
    } catch (const std::exception &e) {
      LOGE("Failed to install QuickJS sandbox: %s", e.what());
    }
  }
}
