#include "pch.h"
#include "RillSandboxNativeModule.h"

#include <JSI/JsiApiContext.h>
#include <jsi/jsi.h>
#include <SandboxEngineConfig.h>

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
#include <QuickJSSandboxJSI.h>
// QuickJS C API for direct testing
extern "C" {
#include <quickjs.h>
}
#endif

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
#include <HermesSandboxNAPI.h>
// Hermes N-API / JSR headers for testHermesNAPI
#include <hermes/js_runtime_api.h>
#endif

#include <chrono>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <windows.h>
#include <psapi.h>

static void rill_log(const std::string &msg) {
  std::string out = "[RillSandbox] " + msg + "\n";
  OutputDebugStringA(out.c_str());
  static std::ofstream logFile("D:\\rill_sandbox.log", std::ios::app);
  if (logFile.is_open()) {
    logFile << out;
    logFile.flush();
  }
}

using Clock = std::chrono::high_resolution_clock;

namespace winrt::RillDemo {

void RillSandboxNativeModule::Initialize(
    winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept {
  m_reactContext = reactContext;
}

bool RillSandboxNativeModule::install() noexcept {
  try {
    if (m_installed) return true;

    // Get the JSI runtime directly (synchronous, works when on JS thread)
    facebook::jsi::Runtime *runtime =
        winrt::Microsoft::ReactNative::TryGetOrCreateContextRuntime(m_reactContext);
    if (!runtime) {
      rill_log("No JSI runtime available");
      return false;
    }

#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
    quickjs_sandbox::QuickJSSandboxModule::install(*runtime);
    rill_log("QuickJS sandbox installed");
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
    hermes_sandbox_napi::HermesSandboxNAPIModule::install(*runtime);
    rill_log("Hermes sandbox installed (N-API)");
#endif

    m_runtime = runtime;
    m_installed = true;
    return true;
  } catch (const std::exception &e) {
    rill_log(std::string("Failed to install engine: ") + e.what());
    return false;
  } catch (...) {
    rill_log("Failed to install engine: unknown error");
    return false;
  }
}

std::string RillSandboxNativeModule::getCompiledSandboxEngine() noexcept {
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
  return "hermes";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
  return "quickjs";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_JSC
  return "jsc";
#else
  return "";
#endif
}

// ---------------------------------------------------------------------------
// QuickJS-only test methods
// ---------------------------------------------------------------------------
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS

std::string RillSandboxNativeModule::testQuickJS() noexcept {
  try {
    std::string r;

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return "FAIL:null_rt";
    r += "rt:OK;";

    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); return r + "FAIL:null_ctx"; }
    r += "ctx:OK;";

    // Simple eval
    const char *code = "1+2";
    JSValue val = JS_Eval(ctx, code, 3, "<test>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(val)) {
      JS_FreeValue(ctx, val);
      r += "eval:EXCEPTION;";
    } else {
      int32_t num = 0;
      JS_ToInt32(ctx, &num, val);
      JS_FreeValue(ctx, val);
      r += "eval=" + std::to_string(num) + ";";
    }

    JS_FreeContext(ctx);
    r += "ctx_free:OK;";
    JS_FreeRuntime(rt);
    r += "rt_free:OK;PASS";
    return r;
  } catch (...) {
    return "EXCEPTION";
  }
}

std::string RillSandboxNativeModule::testQuickJSLevel(int level) noexcept {
  // Level 0: no-op
  // Level 1: NewRuntime + FreeRuntime
  // Level 2: NewRuntime + NewContext + FreeContext + FreeRuntime
  // Level 3: NewRuntime + NewContext + Eval + full cleanup
  // Level 4: NewRuntime + NewContext + Eval (leak, no free)
  // Level 5: NewRuntime + NewContext (leak, no eval, no free)
  // Level 6: NewRuntime + NewContext + FreeContext (leak runtime)
  // Level 7: NewRuntime + JS_NewContextRaw + FreeContext + FreeRuntime (raw ctx, no builtins)
  try {
    std::string r = "L" + std::to_string(level) + ":";

    if (level == 0) {
      return r + "noop;PASS";
    }

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return r + "FAIL:null_rt";
    r += "rt:OK;";

    if (level == 1) {
      JS_FreeRuntime(rt);
      return r + "rt_free:OK;PASS";
    }

    if (level == 7) {
      // Raw context without builtins - full cleanup
      JSContext *ctx = JS_NewContextRaw(rt);
      if (!ctx) { JS_FreeRuntime(rt); return r + "FAIL:null_raw_ctx"; }
      r += "raw_ctx:OK;";
      JS_FreeContext(ctx);
      r += "ctx_free:OK;";
      JS_FreeRuntime(rt);
      return r + "rt_free:OK;PASS";
    }

    if (level == 8) {
      // Raw context without builtins - LEAK everything
      JSContext *ctx = JS_NewContextRaw(rt);
      if (!ctx) { JS_FreeRuntime(rt); return r + "FAIL:null_raw_ctx"; }
      r += "raw_ctx:OK;LEAKED;PASS";
      return r;
    }

    if (level == 9) {
      // NewRuntime only - LEAK (don't free)
      r += "LEAKED_RT;PASS";
      return r;
    }

    if (level >= 10 && level <= 12) {
      // Use JS_NewRuntime2 with custom malloc (NO _msize)
      JS_FreeRuntime(rt); // free the default one

      static JSMallocFunctions simple_mf;
      simple_mf.js_malloc = [](JSMallocState *s, size_t size) -> void * {
        if (s->malloc_size + size > s->malloc_limit)
          return nullptr;
        void *ptr = malloc(size);
        if (!ptr) return nullptr;
        s->malloc_count++;
        s->malloc_size += size;
        return ptr;
      };
      simple_mf.js_free = [](JSMallocState *s, void *ptr) {
        if (!ptr) return;
        s->malloc_count--;
        s->malloc_size -= 16; // rough estimate
        free(ptr);
      };
      simple_mf.js_realloc = [](JSMallocState *s, void *ptr, size_t size) -> void * {
        if (!ptr) {
          if (size == 0) return nullptr;
          return simple_mf.js_malloc(s, size);
        }
        if (size == 0) {
          simple_mf.js_free(s, ptr);
          return nullptr;
        }
        void *new_ptr = realloc(ptr, size);
        if (!new_ptr) return nullptr;
        return new_ptr;
      };
      simple_mf.js_malloc_usable_size = nullptr; // will use dummy (returns 0)

      JSRuntime *rt2 = JS_NewRuntime2(&simple_mf, nullptr);
      if (!rt2) return r + "FAIL:null_rt2";
      r += "rt2:OK;";

      if (level == 10) {
        // Custom malloc runtime + raw context + full cleanup
        JSContext *ctx2 = JS_NewContextRaw(rt2);
        if (!ctx2) { JS_FreeRuntime(rt2); return r + "FAIL:null_ctx2"; }
        r += "raw_ctx2:OK;";
        JS_FreeContext(ctx2);
        r += "ctx_free:OK;";
        JS_FreeRuntime(rt2);
        return r + "rt_free:OK;PASS";
      }
      if (level == 11) {
        // Custom malloc runtime + full context + full cleanup
        JSContext *ctx2 = JS_NewContext(rt2);
        if (!ctx2) { JS_FreeRuntime(rt2); return r + "FAIL:null_ctx2"; }
        r += "ctx2:OK;";
        JS_FreeContext(ctx2);
        r += "ctx_free:OK;";
        JS_FreeRuntime(rt2);
        return r + "rt_free:OK;PASS";
      }
      if (level == 12) {
        // Custom malloc runtime + full context + eval
        JSContext *ctx2 = JS_NewContext(rt2);
        if (!ctx2) { JS_FreeRuntime(rt2); return r + "FAIL:null_ctx2"; }
        r += "ctx2:OK;";
        const char *c = "1+2";
        JSValue v = JS_Eval(ctx2, c, 3, "<t>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(v)) {
          JS_FreeValue(ctx2, v);
          r += "eval:EXC;";
        } else {
          int32_t n = 0;
          JS_ToInt32(ctx2, &n, v);
          JS_FreeValue(ctx2, v);
          r += "eval=" + std::to_string(n) + ";";
        }
        JS_FreeContext(ctx2);
        r += "ctx_free:OK;";
        JS_FreeRuntime(rt2);
        return r + "rt_free:OK;PASS";
      }

      JS_FreeRuntime(rt2);
      return r + "unknown_sublevel";
    }

    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); return r + "FAIL:null_ctx"; }
    r += "ctx:OK;";

    if (level == 5) {
      // Leak everything (no eval, no free)
      return r + "LEAKED;PASS";
    }

    if (level == 6) {
      // Free context but leak runtime
      JS_FreeContext(ctx);
      return r + "ctx_free:OK;LEAKED_RT;PASS";
    }

    if (level == 2) {
      JS_FreeContext(ctx);
      r += "ctx_free:OK;";
      JS_FreeRuntime(rt);
      return r + "rt_free:OK;PASS";
    }

    // Levels 3,4: Eval
    const char *code = "1+2";
    JSValue val = JS_Eval(ctx, code, 3, "<test>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(val)) {
      JS_FreeValue(ctx, val);
      r += "eval:EXCEPTION;";
    } else {
      int32_t num = 0;
      JS_ToInt32(ctx, &num, val);
      JS_FreeValue(ctx, val);
      r += "eval=" + std::to_string(num) + ";";
    }

    if (level == 4) {
      return r + "LEAKED;PASS";
    }

    // Level 3: full cleanup
    JS_FreeContext(ctx);
    r += "ctx_free:OK;";
    JS_FreeRuntime(rt);
    return r + "rt_free:OK;PASS";
  } catch (const std::exception &e) {
    return std::string("EXCEPTION:") + e.what();
  } catch (...) {
    return "EXCEPTION:unknown";
  }
}

#endif // RILL_SANDBOX_ENGINE_QUICKJS

// ---------------------------------------------------------------------------
// Hermes-only test methods
// ---------------------------------------------------------------------------
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES

std::string RillSandboxNativeModule::testHermesNAPI(int level) noexcept {
  rill_log("testHermesNAPI called with level=" + std::to_string(level));
  try {
    std::string r = "L" + std::to_string(level) + ":";

    if (level == 0) {
      return r + "noop;PASS";
    }

    // Level 1: config lifecycle
    jsr_config config = nullptr;
    napi_status s = jsr_create_config(&config);
    if (s != napi_ok || !config) return r + "FAIL:jsr_create_config(" + std::to_string(s) + ")";
    r += "config:OK;";

    if (level == 1) {
      jsr_delete_config(config);
      return r + "config_del:OK;PASS";
    }

    // Level 2: runtime lifecycle
    jsr_runtime runtime = nullptr;
    s = jsr_create_runtime(config, &runtime);
    jsr_delete_config(config);
    config = nullptr;
    if (s != napi_ok || !runtime) return r + "FAIL:jsr_create_runtime(" + std::to_string(s) + ")";
    r += "runtime:OK;";

    if (level == 2) {
      jsr_delete_runtime(runtime);
      return r + "runtime_del:OK;PASS";
    }

    // Level 3: get napi_env
    napi_env env = nullptr;
    s = jsr_runtime_get_node_api_env(runtime, &env);
    if (s != napi_ok || !env) {
      jsr_delete_runtime(runtime);
      return r + "FAIL:jsr_runtime_get_node_api_env(" + std::to_string(s) + ")";
    }
    r += "env:OK;";

    if (level == 3) {
      jsr_delete_runtime(runtime);
      return r + "runtime_del:OK;PASS";
    }

    // Level 4: env scope
    jsr_napi_env_scope envScope = nullptr;
    s = jsr_open_napi_env_scope(env, &envScope);
    if (s != napi_ok) {
      jsr_delete_runtime(runtime);
      return r + "FAIL:jsr_open_napi_env_scope(" + std::to_string(s) + ")";
    }
    r += "scope:OK;";

    if (level == 4) {
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "cleanup:OK;PASS";
    }

    // Level 5: napi_get_global + napi_typeof
    napi_value global = nullptr;
    s = napi_get_global(env, &global);
    if (s != napi_ok || !global) {
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "FAIL:napi_get_global(" + std::to_string(s) + ")";
    }
    napi_valuetype globalType;
    s = napi_typeof(env, global, &globalType);
    r += "global:OK(type=" + std::to_string(globalType) + ");";

    if (level == 5) {
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "cleanup:OK;PASS";
    }

    // Level 6: jsr_run_script
    napi_value source = nullptr;
    const char *code = "1+2";
    s = napi_create_string_utf8(env, code, 3, &source);
    if (s != napi_ok) {
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "FAIL:napi_create_string(" + std::to_string(s) + ")";
    }

    napi_value result = nullptr;
    s = jsr_run_script(env, source, "<test>", &result);
    if (s != napi_ok) {
      // Check for pending exception
      bool hasPending = false;
      napi_is_exception_pending(env, &hasPending);
      if (hasPending) {
        napi_value exc;
        napi_get_and_clear_last_exception(env, &exc);
      }
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "FAIL:jsr_run_script(" + std::to_string(s) + ",exc=" + (hasPending ? "Y" : "N") + ")";
    }

    // Read result
    double resultNum = 0;
    s = napi_get_value_double(env, result, &resultNum);
    if (s == napi_ok) {
      r += "eval=" + std::to_string(static_cast<int>(resultNum)) + ";";
    } else {
      r += "eval:OK(read_fail);";
    }

    if (level == 6) {
      jsr_close_napi_env_scope(env, envScope);
      jsr_delete_runtime(runtime);
      return r + "cleanup:OK;PASS";
    }

    // Level 7: Test via JSI HostObject path (same path as Engine uses)
    jsr_close_napi_env_scope(env, envScope);
    jsr_delete_runtime(runtime);
    r += "raw_cleanup:OK;";

    if (!m_runtime) return r + "FAIL:no_jsi_runtime";

    bool hasHermes = m_runtime->global().hasProperty(*m_runtime, "__HermesSandboxJSI");
    if (!hasHermes) return r + "FAIL:no___HermesSandboxJSI";
    r += "jsi_global:OK;";

    facebook::jsi::Object hermesMod = m_runtime->global()
        .getProperty(*m_runtime, "__HermesSandboxJSI")
        .asObject(*m_runtime);

    facebook::jsi::Function createRtFn = hermesMod
        .getProperty(*m_runtime, "createRuntime")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);
    facebook::jsi::Object rtObj = createRtFn.call(*m_runtime).asObject(*m_runtime);
    r += "jsi_createRuntime:OK;";

    facebook::jsi::Function createCtxFn = rtObj
        .getProperty(*m_runtime, "createContext")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);
    facebook::jsi::Object ctxObj = createCtxFn.call(*m_runtime).asObject(*m_runtime);
    r += "jsi_createContext:OK;";

    facebook::jsi::Function evalFn = ctxObj
        .getProperty(*m_runtime, "eval")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);

    facebook::jsi::String jsCode = facebook::jsi::String::createFromUtf8(*m_runtime, "1+2");
    facebook::jsi::Value evalResult = evalFn.call(*m_runtime, jsCode);
    if (evalResult.isNumber()) {
      r += "jsi_eval=" + std::to_string(static_cast<int>(evalResult.getNumber())) + ";";
    } else {
      r += "jsi_eval:OK(not_number);";
    }

    facebook::jsi::Function dispCtxFn = ctxObj
        .getProperty(*m_runtime, "dispose")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);
    dispCtxFn.call(*m_runtime);
    r += "jsi_ctx_dispose:OK;";

    facebook::jsi::Function dispRtFn = rtObj
        .getProperty(*m_runtime, "dispose")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);
    dispRtFn.call(*m_runtime);
    r += "jsi_rt_dispose:OK;";

    if (level == 7) return r + "PASS";

    // Level 8: Test function injection and callback invocation via JSI
    {
      facebook::jsi::Object hermesMod8 = m_runtime->global()
          .getProperty(*m_runtime, "__HermesSandboxJSI")
          .asObject(*m_runtime);
      facebook::jsi::Function createRtFn8 = hermesMod8
          .getProperty(*m_runtime, "createRuntime")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      facebook::jsi::Object rtObj8 = createRtFn8.call(*m_runtime).asObject(*m_runtime);
      r += "L8_rt:OK;";

      facebook::jsi::Function createCtxFn8 = rtObj8
          .getProperty(*m_runtime, "createContext")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      facebook::jsi::Object ctxObj8 = createCtxFn8.call(*m_runtime).asObject(*m_runtime);
      r += "L8_ctx:OK;";

      // Get inject function
      facebook::jsi::Function injectFn8 = ctxObj8
          .getProperty(*m_runtime, "inject")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);

      // Inject a simple host function: hostAdd(a, b) => a + b
      auto hostAddFn = facebook::jsi::Function::createFromHostFunction(
          *m_runtime,
          facebook::jsi::PropNameID::forAscii(*m_runtime, "hostAdd"),
          2,
          [](facebook::jsi::Runtime &rt, const facebook::jsi::Value &,
             const facebook::jsi::Value *args, size_t count) -> facebook::jsi::Value {
            if (count < 2) return facebook::jsi::Value(0);
            double a = args[0].isNumber() ? args[0].getNumber() : 0;
            double b = args[1].isNumber() ? args[1].getNumber() : 0;
            return facebook::jsi::Value(a + b);
          });

      injectFn8.call(*m_runtime,
                      facebook::jsi::String::createFromUtf8(*m_runtime, "hostAdd"),
                      std::move(hostAddFn));
      r += "L8_inject_fn:OK;";

      // Inject a simple object
      facebook::jsi::Object configObj(*m_runtime);
      configObj.setProperty(*m_runtime, "version",
                            facebook::jsi::String::createFromUtf8(*m_runtime, "1.0"));
      configObj.setProperty(*m_runtime, "count", facebook::jsi::Value(42));
      injectFn8.call(*m_runtime,
                      facebook::jsi::String::createFromUtf8(*m_runtime, "__testConfig"),
                      std::move(configObj));
      r += "L8_inject_obj:OK;";

      // Eval code that calls the host function
      facebook::jsi::Function evalFn8 = ctxObj8
          .getProperty(*m_runtime, "eval")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);

      facebook::jsi::Value callResult = evalFn8.call(*m_runtime,
          facebook::jsi::String::createFromUtf8(*m_runtime, "hostAdd(10, 32)"));
      if (callResult.isNumber()) {
        int val = static_cast<int>(callResult.getNumber());
        r += "L8_call=" + std::to_string(val) + ";";
        if (val != 42) r += "L8_WRONG_RESULT;";
      } else {
        r += "L8_call:NOT_NUMBER;";
      }

      // Eval code that reads the injected object
      facebook::jsi::Value cfgResult = evalFn8.call(*m_runtime,
          facebook::jsi::String::createFromUtf8(*m_runtime,
              "__testConfig.version + ':' + __testConfig.count"));
      if (cfgResult.isString()) {
        r += "L8_obj=" + cfgResult.getString(*m_runtime).utf8(*m_runtime) + ";";
      } else {
        r += "L8_obj:NOT_STRING;";
      }

      // Dispose
      facebook::jsi::Function dispCtxFn8 = ctxObj8
          .getProperty(*m_runtime, "dispose")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      dispCtxFn8.call(*m_runtime);
      facebook::jsi::Function dispRtFn8 = rtObj8
          .getProperty(*m_runtime, "dispose")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      dispRtFn8.call(*m_runtime);
      r += "L8_dispose:OK;";
    }

    if (level == 8) return r + "PASS";

    // Level 9: Test a larger eval (multi-statement code with loops)
    {
      facebook::jsi::Object hermesMod9 = m_runtime->global()
          .getProperty(*m_runtime, "__HermesSandboxJSI")
          .asObject(*m_runtime);
      facebook::jsi::Function createRtFn9 = hermesMod9
          .getProperty(*m_runtime, "createRuntime")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      facebook::jsi::Object rtObj9 = createRtFn9.call(*m_runtime).asObject(*m_runtime);
      facebook::jsi::Function createCtxFn9 = rtObj9
          .getProperty(*m_runtime, "createContext")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      facebook::jsi::Object ctxObj9 = createCtxFn9.call(*m_runtime).asObject(*m_runtime);
      r += "L9_ctx:OK;";

      facebook::jsi::Function evalFn9 = ctxObj9
          .getProperty(*m_runtime, "eval")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);

      // Run a moderately complex script
      const char *bigCode =
          "var sum = 0;\n"
          "for (var i = 0; i < 1000; i++) { sum += i; }\n"
          "var arr = [];\n"
          "for (var j = 0; j < 100; j++) { arr.push({ idx: j, val: j * j }); }\n"
          "var json = JSON.stringify(arr);\n"
          "sum + ':' + arr.length + ':' + json.length;\n";

      facebook::jsi::Value bigResult = evalFn9.call(*m_runtime,
          facebook::jsi::String::createFromUtf8(*m_runtime, bigCode));
      if (bigResult.isString()) {
        r += "L9_eval=" + bigResult.getString(*m_runtime).utf8(*m_runtime) + ";";
      } else {
        r += "L9_eval:OK;";
      }

      // Dispose
      facebook::jsi::Function dispCtxFn9 = ctxObj9
          .getProperty(*m_runtime, "dispose")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      dispCtxFn9.call(*m_runtime);
      facebook::jsi::Function dispRtFn9 = rtObj9
          .getProperty(*m_runtime, "dispose")
          .asObject(*m_runtime)
          .asFunction(*m_runtime);
      dispRtFn9.call(*m_runtime);
      r += "L9_dispose:OK;";
    }

    std::string finalResult = r + "PASS";
    rill_log("testHermesNAPI result: " + finalResult);
    return finalResult;

  } catch (const facebook::jsi::JSError &e) {
    std::string errResult = "JSI_ERROR:" + std::string(e.what());
    rill_log("testHermesNAPI result: " + errResult);
    return errResult;
  } catch (const std::exception &e) {
    std::string errResult = "EXCEPTION:" + std::string(e.what());
    rill_log("testHermesNAPI result: " + errResult);
    return errResult;
  } catch (...) {
    rill_log("testHermesNAPI result: EXCEPTION:unknown");
    return "EXCEPTION:unknown";
  }
}

#endif // RILL_SANDBOX_ENGINE_HERMES

// ---------------------------------------------------------------------------
// Helper: detect sandbox JSI global
// ---------------------------------------------------------------------------
static std::string detectSandboxGlobal(facebook::jsi::Runtime &rt, const std::string &hint) {
  auto compiledSandboxGlobalName = []() -> std::string {
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
    return "__HermesSandboxJSI";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
    return "__QuickJSSandboxJSI";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_JSC
    return "__JSCSandboxJSI";
#else
    return "";
#endif
  };

  auto sandboxGlobalName = [](const std::string &engine) -> std::string {
    if (engine == "hermes") return "__HermesSandboxJSI";
    if (engine == "quickjs") return "__QuickJSSandboxJSI";
    if (engine == "jsc") return "__JSCSandboxJSI";
    return "";
  };

  if (!hint.empty()) {
    auto name = sandboxGlobalName(hint);
    if (!name.empty() && rt.global().hasProperty(rt, name.c_str())) {
      return name;
    }
  }

  auto compiled = compiledSandboxGlobalName();
  if (!compiled.empty() && rt.global().hasProperty(rt, compiled.c_str())) {
    return compiled;
  }

  for (const auto &candidate : {"__HermesSandboxJSI", "__QuickJSSandboxJSI", "__JSCSandboxJSI"}) {
    if (compiled == candidate) continue;
    if (rt.global().hasProperty(rt, candidate)) {
      return candidate;
    }
  }
  return "";
}

static std::string dirnameOfExe() {
  char exePath[MAX_PATH] = {};
  DWORD len = GetModuleFileNameA(nullptr, exePath, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) return "";
  std::string p(exePath, len);
  auto pos = p.find_last_of("\\/");
  if (pos == std::string::npos) return "";
  return p.substr(0, pos);
}

static std::string normalizeSlashes(std::string p) {
  for (auto &c : p) if (c == '/') c = '\\';
  return p;
}

static bool readBinaryFile(const std::string &path, std::vector<uint8_t> &out) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f.is_open()) return false;
  std::streamsize sz = f.tellg();
  if (sz <= 0) return false;
  f.seekg(0, std::ios::beg);
  out.resize(static_cast<size_t>(sz));
  return static_cast<bool>(f.read(reinterpret_cast<char *>(out.data()), sz));
}

static bool readBinaryFileCached(const std::string &path, std::vector<uint8_t> &out) {
  static std::mutex s_cacheMutex;
  static std::unordered_map<std::string, std::vector<uint8_t>> s_cache;

  {
    std::lock_guard<std::mutex> lock(s_cacheMutex);
    auto it = s_cache.find(path);
    if (it != s_cache.end()) {
      out = it->second;
      return true;
    }
  }

  std::vector<uint8_t> loaded;
  if (!readBinaryFile(path, loaded)) {
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(s_cacheMutex);
    s_cache[path] = loaded;
  }
  out = std::move(loaded);
  return true;
}

static std::string resolveAssetPath(const std::string &inputPath) {
  std::string p = normalizeSlashes(inputPath);
  if (p.empty()) return "";
  // Absolute Windows path (C:\...) or UNC path.
  if ((p.size() > 2 && p[1] == ':') || (p.size() > 1 && p[0] == '\\' && p[1] == '\\')) {
    return p;
  }

  std::string exeDir = dirnameOfExe();
  if (exeDir.empty()) return p;

  std::vector<std::string> candidates = {
      exeDir + "\\" + p,
      exeDir + "\\Bundle\\" + p,
      exeDir + "\\WindowsDemo\\Bundle\\" + p,
  };

  for (const auto &c : candidates) {
    DWORD attrs = GetFileAttributesA(c.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
      return c;
    }
  }
  return exeDir + "\\Bundle\\" + p;
}

// ---------------------------------------------------------------------------
// Performance methods
// ---------------------------------------------------------------------------

double RillSandboxNativeModule::getMemoryUsage() noexcept {
  try {
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
      return static_cast<double>(pmc.WorkingSetSize) / (1024.0 * 1024.0);
    }
  } catch (...) {}
  return -1.0;
}

double RillSandboxNativeModule::measureJSIRTT(int iterations) noexcept {
  if (!m_runtime || iterations <= 0) return -1.0;

  try {
    auto globalName = detectSandboxGlobal(*m_runtime, "");
    if (globalName.empty()) return -1.0;

    facebook::jsi::Object sandboxObj = m_runtime->global()
        .getProperty(*m_runtime, globalName.c_str())
        .asObject(*m_runtime);

    facebook::jsi::Function isAvailableFn = sandboxObj
        .getProperty(*m_runtime, "isAvailable")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);

    auto start = Clock::now();
    for (int i = 0; i < iterations; i++) {
      isAvailableFn.call(*m_runtime);
    }
    auto end = Clock::now();

    double totalMs = std::chrono::duration<double, std::milli>(end - start).count();
    return totalMs / iterations;

  } catch (const std::exception &e) {
    OutputDebugStringA("[RillPerf] measureJSIRTT exception: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (...) {
    return -1.0;
  }
}

double RillSandboxNativeModule::measureOpsPerSecond(int durationMs) noexcept {
  if (!m_runtime || durationMs <= 0) return -1.0;

  try {
    auto globalName = detectSandboxGlobal(*m_runtime, "");
    if (globalName.empty()) return -1.0;

    facebook::jsi::Object sandboxObj = m_runtime->global()
        .getProperty(*m_runtime, globalName.c_str())
        .asObject(*m_runtime);

    facebook::jsi::Function isAvailableFn = sandboxObj
        .getProperty(*m_runtime, "isAvailable")
        .asObject(*m_runtime)
        .asFunction(*m_runtime);

    int opCount = 0;
    auto start = Clock::now();
    auto deadline = start + std::chrono::milliseconds(durationMs);

    while (Clock::now() < deadline) {
      isAvailableFn.call(*m_runtime);
      opCount++;
    }

    double actualSec = std::chrono::duration<double>(Clock::now() - start).count();
    return opCount / actualSec;

  } catch (const std::exception &e) {
    OutputDebugStringA("[RillPerf] measureOpsPerSecond exception: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (...) {
    return -1.0;
  }
}

double RillSandboxNativeModule::evalInSandbox(std::string code, std::string engine) noexcept {
  if (!m_runtime) return -1.0;

  try {
    auto globalName = detectSandboxGlobal(*m_runtime, engine);
    if (globalName.empty()) return -1.0;

    auto &rt = *m_runtime;
    facebook::jsi::Object hostGlobal = rt.global();

    const char *kPerfEngineKey = "__RillPerfSandboxEngine";
    const char *kPerfRuntimeKey = "__RillPerfSandboxRuntime";
    const char *kPerfContextKey = "__RillPerfSandboxContext";

    auto disposeHostObject = [&](const char *key) {
      if (!hostGlobal.hasProperty(rt, key)) return;
      auto v = hostGlobal.getProperty(rt, key);
      if (!v.isObject()) {
        hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
        return;
      }
      auto obj = v.asObject(rt);
      if (obj.hasProperty(rt, "dispose")) {
        auto dv = obj.getProperty(rt, "dispose");
        if (dv.isObject() && dv.asObject(rt).isFunction(rt)) {
          dv.asObject(rt).asFunction(rt).call(rt);
        }
      }
      hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
    };

    std::string cachedEngine;
    if (hostGlobal.hasProperty(rt, kPerfEngineKey)) {
      auto ev = hostGlobal.getProperty(rt, kPerfEngineKey);
      if (ev.isString()) cachedEngine = ev.asString(rt).utf8(rt);
    }

    bool hasRuntime = hostGlobal.hasProperty(rt, kPerfRuntimeKey) &&
                      hostGlobal.getProperty(rt, kPerfRuntimeKey).isObject();
    bool hasContext = hostGlobal.hasProperty(rt, kPerfContextKey) &&
                      hostGlobal.getProperty(rt, kPerfContextKey).isObject();

    if (cachedEngine != globalName || !hasRuntime || !hasContext) {
      disposeHostObject(kPerfContextKey);
      disposeHostObject(kPerfRuntimeKey);

      facebook::jsi::Object sandboxModule = hostGlobal
          .getProperty(rt, globalName.c_str())
          .asObject(rt);

      // createRuntime()
      facebook::jsi::Function createRuntimeFn = sandboxModule
          .getProperty(rt, "createRuntime")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object sandboxRuntime = createRuntimeFn.call(rt).asObject(rt);

      // createContext()
      facebook::jsi::Function createContextFn = sandboxRuntime
          .getProperty(rt, "createContext")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object context = createContextFn.call(rt).asObject(rt);

      hostGlobal.setProperty(rt, kPerfRuntimeKey, sandboxRuntime);
      hostGlobal.setProperty(rt, kPerfContextKey, context);
      hostGlobal.setProperty(
          rt,
          kPerfEngineKey,
          facebook::jsi::String::createFromUtf8(rt, globalName));
    }

    facebook::jsi::Object context = hostGlobal
        .getProperty(rt, kPerfContextKey)
        .asObject(rt);

    // eval(code)
    facebook::jsi::Function evalFn = context
        .getProperty(rt, "eval")
        .asObject(rt)
        .asFunction(rt);

    auto start = Clock::now();
    facebook::jsi::String jsCode = facebook::jsi::String::createFromUtf8(rt, code);
    evalFn.call(rt, jsCode);
    auto end = Clock::now();

    double execMs = std::chrono::duration<double, std::milli>(end - start).count();
    return execMs;

  } catch (const facebook::jsi::JSError &e) {
    OutputDebugStringA("[RillPerf] evalInSandbox JSI error: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (const std::exception &e) {
    OutputDebugStringA("[RillPerf] evalInSandbox exception: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (...) {
    return -1.0;
  }
}

bool RillSandboxNativeModule::supportsBytecodeEval(std::string engine) noexcept {
  if (!m_runtime) return false;

  try {
    auto globalName = detectSandboxGlobal(*m_runtime, engine);
    if (globalName.empty()) return false;

    auto &rt = *m_runtime;
    facebook::jsi::Object sandboxModule = rt.global()
        .getProperty(rt, globalName.c_str())
        .asObject(rt);

    facebook::jsi::Function createRuntimeFn = sandboxModule
        .getProperty(rt, "createRuntime")
        .asObject(rt)
        .asFunction(rt);
    facebook::jsi::Object sandboxRuntime = createRuntimeFn.call(rt).asObject(rt);

    facebook::jsi::Function createContextFn = sandboxRuntime
        .getProperty(rt, "createContext")
        .asObject(rt)
        .asFunction(rt);
    facebook::jsi::Object context = createContextFn.call(rt).asObject(rt);

    bool ok = context.hasProperty(rt, "evalBytecode");

    if (context.hasProperty(rt, "dispose")) {
      context.getProperty(rt, "dispose").asObject(rt).asFunction(rt).call(rt);
    }
    if (sandboxRuntime.hasProperty(rt, "dispose")) {
      sandboxRuntime.getProperty(rt, "dispose").asObject(rt).asFunction(rt).call(rt);
    }

    return ok;
  } catch (...) {
    return false;
  }
}

double RillSandboxNativeModule::evalBytecodeAsset(std::string path, std::string engine) noexcept {
  if (!m_runtime) return -1.0;

  try {
    std::string resolved = resolveAssetPath(path);
    std::vector<uint8_t> bytecode;
    if (!readBinaryFileCached(resolved, bytecode)) {
      return -1.0;
    }

    auto globalName = detectSandboxGlobal(*m_runtime, engine);
    if (globalName.empty()) return -1.0;

    auto &rt = *m_runtime;
    facebook::jsi::Object hostGlobal = rt.global();

    const char *kPerfEngineKey = "__RillPerfSandboxEngine";
    const char *kPerfRuntimeKey = "__RillPerfSandboxRuntime";
    const char *kPerfContextKey = "__RillPerfSandboxContext";

    auto disposeHostObject = [&](const char *key) {
      if (!hostGlobal.hasProperty(rt, key)) return;
      auto v = hostGlobal.getProperty(rt, key);
      if (!v.isObject()) {
        hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
        return;
      }
      auto obj = v.asObject(rt);
      if (obj.hasProperty(rt, "dispose")) {
        auto dv = obj.getProperty(rt, "dispose");
        if (dv.isObject() && dv.asObject(rt).isFunction(rt)) {
          dv.asObject(rt).asFunction(rt).call(rt);
        }
      }
      hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
    };

    std::string cachedEngine;
    if (hostGlobal.hasProperty(rt, kPerfEngineKey)) {
      auto ev = hostGlobal.getProperty(rt, kPerfEngineKey);
      if (ev.isString()) cachedEngine = ev.asString(rt).utf8(rt);
    }

    bool hasRuntime = hostGlobal.hasProperty(rt, kPerfRuntimeKey) &&
                      hostGlobal.getProperty(rt, kPerfRuntimeKey).isObject();
    bool hasContext = hostGlobal.hasProperty(rt, kPerfContextKey) &&
                      hostGlobal.getProperty(rt, kPerfContextKey).isObject();

    if (cachedEngine != globalName || !hasRuntime || !hasContext) {
      disposeHostObject(kPerfContextKey);
      disposeHostObject(kPerfRuntimeKey);

      facebook::jsi::Object sandboxModule = hostGlobal
          .getProperty(rt, globalName.c_str())
          .asObject(rt);

      facebook::jsi::Function createRuntimeFn = sandboxModule
          .getProperty(rt, "createRuntime")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object sandboxRuntime = createRuntimeFn.call(rt).asObject(rt);

      facebook::jsi::Function createContextFn = sandboxRuntime
          .getProperty(rt, "createContext")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object context = createContextFn.call(rt).asObject(rt);

      hostGlobal.setProperty(rt, kPerfRuntimeKey, sandboxRuntime);
      hostGlobal.setProperty(rt, kPerfContextKey, context);
      hostGlobal.setProperty(
          rt,
          kPerfEngineKey,
          facebook::jsi::String::createFromUtf8(rt, globalName));
    }

    facebook::jsi::Object context = hostGlobal
        .getProperty(rt, kPerfContextKey)
        .asObject(rt);

    if (!context.hasProperty(rt, "evalBytecode")) return -1.0;

    facebook::jsi::Function evalBytecodeFn = context
        .getProperty(rt, "evalBytecode")
        .asObject(rt)
        .asFunction(rt);

    auto ab = rt.global().getPropertyAsFunction(rt, "ArrayBuffer")
        .callAsConstructor(rt, static_cast<double>(bytecode.size()))
        .asObject(rt)
        .getArrayBuffer(rt);
    std::memcpy(ab.data(rt), bytecode.data(), bytecode.size());

    auto start = Clock::now();
    evalBytecodeFn.call(
        rt,
        ab,
        facebook::jsi::String::createFromUtf8(rt, resolved));
    auto end = Clock::now();
    return std::chrono::duration<double, std::milli>(end - start).count();
  } catch (const facebook::jsi::JSError &e) {
    OutputDebugStringA("[RillPerf] evalBytecodeAsset JSI error: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (const std::exception &e) {
    OutputDebugStringA("[RillPerf] evalBytecodeAsset exception: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (...) {
    return -1.0;
  }
}

double RillSandboxNativeModule::runSandboxBenchmark(
    std::string code,
    std::string bytecodePath,
    std::string engine,
    int warmup,
    int iterations) noexcept {
  if (!m_runtime || iterations <= 0) return -1.0;
  if (warmup < 0) warmup = 0;

  try {
    auto globalName = detectSandboxGlobal(*m_runtime, engine);
    if (globalName.empty()) return -1.0;

    auto &rt = *m_runtime;
    facebook::jsi::Object hostGlobal = rt.global();

    const char *kPerfEngineKey = "__RillPerfSandboxEngine";
    const char *kPerfRuntimeKey = "__RillPerfSandboxRuntime";
    const char *kPerfContextKey = "__RillPerfSandboxContext";

    auto disposeHostObject = [&](const char *key) {
      if (!hostGlobal.hasProperty(rt, key)) return;
      auto v = hostGlobal.getProperty(rt, key);
      if (!v.isObject()) {
        hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
        return;
      }
      auto obj = v.asObject(rt);
      if (obj.hasProperty(rt, "dispose")) {
        auto dv = obj.getProperty(rt, "dispose");
        if (dv.isObject() && dv.asObject(rt).isFunction(rt)) {
          dv.asObject(rt).asFunction(rt).call(rt);
        }
      }
      hostGlobal.setProperty(rt, key, facebook::jsi::Value::undefined());
    };

    std::string cachedEngine;
    if (hostGlobal.hasProperty(rt, kPerfEngineKey)) {
      auto ev = hostGlobal.getProperty(rt, kPerfEngineKey);
      if (ev.isString()) cachedEngine = ev.asString(rt).utf8(rt);
    }

    bool hasRuntime = hostGlobal.hasProperty(rt, kPerfRuntimeKey) &&
                      hostGlobal.getProperty(rt, kPerfRuntimeKey).isObject();
    bool hasContext = hostGlobal.hasProperty(rt, kPerfContextKey) &&
                      hostGlobal.getProperty(rt, kPerfContextKey).isObject();

    if (cachedEngine != globalName || !hasRuntime || !hasContext) {
      disposeHostObject(kPerfContextKey);
      disposeHostObject(kPerfRuntimeKey);

      facebook::jsi::Object sandboxModule = hostGlobal
          .getProperty(rt, globalName.c_str())
          .asObject(rt);

      facebook::jsi::Function createRuntimeFn = sandboxModule
          .getProperty(rt, "createRuntime")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object sandboxRuntime = createRuntimeFn.call(rt).asObject(rt);

      facebook::jsi::Function createContextFn = sandboxRuntime
          .getProperty(rt, "createContext")
          .asObject(rt)
          .asFunction(rt);
      facebook::jsi::Object context = createContextFn.call(rt).asObject(rt);

      hostGlobal.setProperty(rt, kPerfRuntimeKey, sandboxRuntime);
      hostGlobal.setProperty(rt, kPerfContextKey, context);
      hostGlobal.setProperty(
          rt,
          kPerfEngineKey,
          facebook::jsi::String::createFromUtf8(rt, globalName));
    }

    facebook::jsi::Object context = hostGlobal
        .getProperty(rt, kPerfContextKey)
        .asObject(rt);

    bool useBytecode = !bytecodePath.empty() && context.hasProperty(rt, "evalBytecode");
    std::unique_ptr<facebook::jsi::Function> evalFn;
    std::unique_ptr<facebook::jsi::Function> evalBytecodeFn;
    facebook::jsi::String codeString = facebook::jsi::String::createFromUtf8(rt, code);
    facebook::jsi::String sourceString = facebook::jsi::String::createFromUtf8(rt, "<bench-bytecode>");
    std::unique_ptr<facebook::jsi::ArrayBuffer> bytecodeArrayBuffer;

    if (useBytecode) {
      std::string resolved = resolveAssetPath(bytecodePath);
      std::vector<uint8_t> bytecode;
      if (!readBinaryFileCached(resolved, bytecode)) {
        useBytecode = false;
      } else {
        evalBytecodeFn = std::make_unique<facebook::jsi::Function>(
            context.getProperty(rt, "evalBytecode").asObject(rt).asFunction(rt));
        sourceString = facebook::jsi::String::createFromUtf8(rt, resolved);
        bytecodeArrayBuffer = std::make_unique<facebook::jsi::ArrayBuffer>(
            rt.global()
                .getPropertyAsFunction(rt, "ArrayBuffer")
                .callAsConstructor(rt, static_cast<double>(bytecode.size()))
                .asObject(rt)
                .getArrayBuffer(rt));
        std::memcpy(bytecodeArrayBuffer->data(rt), bytecode.data(), bytecode.size());
      }
    }

    if (!useBytecode) {
      evalFn = std::make_unique<facebook::jsi::Function>(
          context.getProperty(rt, "eval").asObject(rt).asFunction(rt));
    }

    auto runOnce = [&]() {
      if (useBytecode) {
        evalBytecodeFn->call(rt, *bytecodeArrayBuffer, sourceString);
      } else {
        evalFn->call(rt, codeString);
      }
    };

    for (int i = 0; i < warmup; i++) {
      runOnce();
    }

    auto start = Clock::now();
    for (int i = 0; i < iterations; i++) {
      runOnce();
    }
    auto end = Clock::now();

    double totalMs = std::chrono::duration<double, std::milli>(end - start).count();
    return totalMs / static_cast<double>(iterations);
  } catch (const facebook::jsi::JSError &e) {
    OutputDebugStringA("[RillPerf] runSandboxBenchmark JSI error: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (const std::exception &e) {
    OutputDebugStringA("[RillPerf] runSandboxBenchmark exception: ");
    OutputDebugStringA(e.what());
    OutputDebugStringA("\n");
    return -1.0;
  } catch (...) {
    return -1.0;
  }
}

} // namespace winrt::RillDemo
