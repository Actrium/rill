#include <jni.h>
#include <jsi/jsi.h>
#include <android/log.h>
#include <chrono>
#include <string>

#undef LOG_TAG
#define LOG_TAG "RillPerfBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

using namespace facebook;
using Clock = std::chrono::high_resolution_clock;

// ---------------------------------------------------------------------------
// Helper: resolve the sandbox JSI global for a given engine name
// ---------------------------------------------------------------------------
static std::string sandboxGlobalName(const std::string &engine) {
    if (engine == "hermes") return "__HermesSandboxJSI";
    if (engine == "quickjs") return "__QuickJSSandboxJSI";
    if (engine == "jsc")     return "__JSCSandboxJSI";
    return "";
}

// Detect which sandbox is available, preferring the given engine hint
static std::string detectSandboxGlobal(jsi::Runtime &rt, const std::string &hint) {
    // Try the hint first
    if (!hint.empty()) {
        auto name = sandboxGlobalName(hint);
        if (!name.empty() && rt.global().hasProperty(rt, name.c_str())) {
            return name;
        }
    }
    // Fallback: check all known sandboxes
    for (const auto &candidate : {"__QuickJSSandboxJSI", "__HermesSandboxJSI", "__JSCSandboxJSI"}) {
        if (rt.global().hasProperty(rt, candidate)) {
            return candidate;
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// nativeMeasureJSIRTT — call isAvailable() N times, return avg ms
// ---------------------------------------------------------------------------
extern "C" JNIEXPORT jdouble JNICALL
Java_com_rill_demo_RillPerformanceBridge_nativeMeasureJSIRTT(
    JNIEnv *env, jobject thiz, jlong runtimePtr, jint iterations) {

    if (runtimePtr == 0 || iterations <= 0) return -1.0;

    auto *runtime = reinterpret_cast<jsi::Runtime *>(runtimePtr);

    try {
        auto globalName = detectSandboxGlobal(*runtime, "");
        if (globalName.empty()) {
            LOGE("measureJSIRTT: no sandbox global found");
            return -1.0;
        }

        jsi::Object sandboxObj = runtime->global()
            .getProperty(*runtime, globalName.c_str())
            .asObject(*runtime);

        jsi::Function isAvailableFn = sandboxObj
            .getProperty(*runtime, "isAvailable")
            .asObject(*runtime)
            .asFunction(*runtime);

        auto start = Clock::now();
        for (int i = 0; i < iterations; i++) {
            isAvailableFn.call(*runtime);
        }
        auto end = Clock::now();

        double totalMs = std::chrono::duration<double, std::milli>(end - start).count();
        return totalMs / iterations;

    } catch (const std::exception &e) {
        LOGE("measureJSIRTT exception: %s", e.what());
        return -1.0;
    }
}

// ---------------------------------------------------------------------------
// nativeMeasureOpsPerSecond — call isAvailable() for durationMs, return ops/s
// ---------------------------------------------------------------------------
extern "C" JNIEXPORT jdouble JNICALL
Java_com_rill_demo_RillPerformanceBridge_nativeMeasureOpsPerSecond(
    JNIEnv *env, jobject thiz, jlong runtimePtr, jint durationMs) {

    if (runtimePtr == 0 || durationMs <= 0) return -1.0;

    auto *runtime = reinterpret_cast<jsi::Runtime *>(runtimePtr);

    try {
        auto globalName = detectSandboxGlobal(*runtime, "");
        if (globalName.empty()) {
            LOGE("measureOpsPerSecond: no sandbox global found");
            return -1.0;
        }

        jsi::Object sandboxObj = runtime->global()
            .getProperty(*runtime, globalName.c_str())
            .asObject(*runtime);

        jsi::Function isAvailableFn = sandboxObj
            .getProperty(*runtime, "isAvailable")
            .asObject(*runtime)
            .asFunction(*runtime);

        int opCount = 0;
        auto start = Clock::now();
        auto deadline = start + std::chrono::milliseconds(durationMs);

        while (Clock::now() < deadline) {
            isAvailableFn.call(*runtime);
            opCount++;
        }

        double actualSec = std::chrono::duration<double>(Clock::now() - start).count();
        return opCount / actualSec;

    } catch (const std::exception &e) {
        LOGE("measureOpsPerSecond exception: %s", e.what());
        return -1.0;
    }
}

// ---------------------------------------------------------------------------
// nativeEvalInSandbox — create runtime → context → eval(code) → dispose
// Returns execution time in ms
// ---------------------------------------------------------------------------
extern "C" JNIEXPORT jdouble JNICALL
Java_com_rill_demo_RillPerformanceBridge_nativeEvalInSandbox(
    JNIEnv *env, jobject thiz, jlong runtimePtr, jstring jCode, jstring jEngine) {

    if (runtimePtr == 0) return -1.0;

    auto *runtime = reinterpret_cast<jsi::Runtime *>(runtimePtr);

    // Convert Java strings
    const char *cCode = env->GetStringUTFChars(jCode, nullptr);
    const char *cEngine = env->GetStringUTFChars(jEngine, nullptr);
    std::string code(cCode);
    std::string engine(cEngine);
    env->ReleaseStringUTFChars(jCode, cCode);
    env->ReleaseStringUTFChars(jEngine, cEngine);

    try {
        auto globalName = detectSandboxGlobal(*runtime, engine);
        if (globalName.empty()) {
            LOGE("evalInSandbox: no sandbox global found for engine '%s'", engine.c_str());
            return -1.0;
        }

        jsi::Object sandboxModule = runtime->global()
            .getProperty(*runtime, globalName.c_str())
            .asObject(*runtime);

        // createRuntime()
        jsi::Function createRuntimeFn = sandboxModule
            .getProperty(*runtime, "createRuntime")
            .asObject(*runtime)
            .asFunction(*runtime);
        jsi::Object sandboxRuntime = createRuntimeFn.call(*runtime).asObject(*runtime);

        // createContext()
        jsi::Function createContextFn = sandboxRuntime
            .getProperty(*runtime, "createContext")
            .asObject(*runtime)
            .asFunction(*runtime);
        jsi::Object context = createContextFn.call(*runtime).asObject(*runtime);

        // eval(code)
        jsi::Function evalFn = context
            .getProperty(*runtime, "eval")
            .asObject(*runtime)
            .asFunction(*runtime);

        auto start = Clock::now();

        jsi::String jsCode = jsi::String::createFromUtf8(*runtime, code);
        evalFn.call(*runtime, jsCode);

        auto end = Clock::now();
        double execMs = std::chrono::duration<double, std::milli>(end - start).count();

        // dispose context and runtime
        jsi::Function disposeCtxFn = context
            .getProperty(*runtime, "dispose")
            .asObject(*runtime)
            .asFunction(*runtime);
        disposeCtxFn.call(*runtime);

        jsi::Function disposeRtFn = sandboxRuntime
            .getProperty(*runtime, "dispose")
            .asObject(*runtime)
            .asFunction(*runtime);
        disposeRtFn.call(*runtime);

        return execMs;

    } catch (const jsi::JSError &e) {
        LOGE("evalInSandbox JSI error: %s", e.what());
        return -1.0;
    } catch (const std::exception &e) {
        LOGE("evalInSandbox exception: %s", e.what());
        return -1.0;
    }
}
