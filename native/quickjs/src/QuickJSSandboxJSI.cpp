#include "QuickJSSandboxJSI.h"
#include <cstring>
#include <sstream>

#ifdef RILL_QJS_DEBUG
#include "QuickJSDebugCore.h"
#include "QuickJSEngineDebugger.h"
#include "devtools/AdapterDebugTarget.h"
#include "devtools/DebuggerAdapter.h"
#include <ReactCommon/CallInvoker.h>
#include <vector>
#endif
#ifdef _WIN32
#include <windows.h>
#endif

namespace quickjs_sandbox {

// Static counter for sandbox functions
static int g_sandboxFuncCounter = 0;

// Static member for HostFunctionData class id
JSClassID QuickJSSandboxContext::hostFunctionDataClassID_ = 0;

void QuickJSSandboxContext::hostFunctionDataFinalizer(JSRuntime *rt,
                                                      JSValue val) {
  (void)rt;
  HostFunctionData *data = static_cast<HostFunctionData *>(
      JS_GetOpaque(val, hostFunctionDataClassID_));
  if (data) {
    // Remove from callbacks map if context still exists
    if (data->self && !data->self->disposed_) {
      data->self->callbacks_.erase(data->callbackId);
    }
    delete data;
  }
}

void QuickJSSandboxContext::ensureClassRegistered() {
  if (hostFunctionDataClassID_ == 0) {
    JS_NewClassID(&hostFunctionDataClassID_);
  }

  // IMPORTANT: register on *each* JSRuntime (createRuntime() creates new runtimes).
  if (!JS_IsRegisteredClass(qjsRuntime_, hostFunctionDataClassID_)) {
    JSClassDef classDef = {
        .class_name = "HostFunctionData",
        .finalizer = hostFunctionDataFinalizer,
    };
    if (JS_NewClass(qjsRuntime_, hostFunctionDataClassID_, &classDef) < 0) {
      throw jsi::JSError(*hostRuntime_,
                         "Failed to register HostFunctionData class");
    }
  }
}

// MARK: - QuickJSSandboxContext Implementation

QuickJSSandboxContext::QuickJSSandboxContext(
    jsi::Runtime &hostRuntime, JSRuntime *qjsRuntime, double timeoutMs,
    std::shared_ptr<InterruptState> interruptState)
    : qjsContext_(nullptr), qjsRuntime_(qjsRuntime), hostRuntime_(&hostRuntime),
      timeoutMs_(timeoutMs), interruptState_(std::move(interruptState)),
      disposed_(false), callbackCounter_(0) {
  qjsContext_ = JS_NewContext(qjsRuntime_);
  if (!qjsContext_) {
    throw jsi::JSError(hostRuntime, "Failed to create QuickJS context");
  }

  // Register the class for HostFunctionData
  ensureClassRegistered();

  // Install console
  installConsole();
}

QuickJSSandboxContext::~QuickJSSandboxContext() { dispose(); }

void QuickJSSandboxContext::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  callbacks_.clear();
  
  // Free cached JSValue wrappers before freeing context
  for (auto &pair : wrapperCache_) {
    JS_FreeValue(qjsContext_, pair.second);
  }
  wrapperCache_.clear();

#ifdef RILL_QJS_DEBUG
  // Unregister the interpreter debug hook before the context it references goes
  // away (the QuickJSEngineDebugger that captured the paused callback has already
  // been torn down with its debug target at tenant destroy).
  debugCore_.reset();
#endif

  if (qjsContext_) {
    JS_FreeContext(qjsContext_);
    qjsContext_ = nullptr;
  }
}

#ifdef RILL_QJS_DEBUG
std::shared_ptr<rill::devtools::IEngineDebugTarget>
QuickJSSandboxContext::createCdpDebugTarget(
    std::shared_ptr<facebook::react::CallInvoker> /*callInvoker*/,
    std::int32_t executionContextId) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_) return nullptr;

  // Lazily attach the engine debug controller — creating it registers the global
  // interpreter hook, so only a tenant that is actually being debugged pays for
  // it (non-debugged QuickJS contexts stay on the pristine dispatch path).
  if (!debugCore_) {
    debugCore_ =
        std::make_unique<rill::qjs_debug::QuickJSDebugCore>(qjsRuntime_, qjsContext_);
  }

  const auto tenantId = static_cast<rill::devtools::TenantId>(executionContextId);
  auto engineDbg = std::make_shared<rill::qjs_debug::QuickJSEngineDebugger>(
      debugCore_.get(), tenantId);
  auto adapter = std::make_shared<rill::devtools::DebuggerAdapter>();
  adapter->setEngineDebugger(engineDbg);
  auto target = std::make_shared<rill::devtools::AdapterDebugTarget>(adapter, tenantId);

  // Engine pause -> Debugger.paused through the adapter's per-connection sinks.
  // Capture the adapter raw (no ownership cycle): the adapter owns engineDbg,
  // which owns this notifier, so the adapter outlives every notifier call.
  rill::devtools::DebuggerAdapter* adapterRaw = adapter.get();
  engineDbg->setPausedNotifier(
      [adapterRaw, tenantId](rill::devtools::PauseReason r,
                             const std::vector<rill::devtools::CallFrame>& frames,
                             const std::vector<std::string>& hits) {
        adapterRaw->onPaused(tenantId, r, frames, hits);
      });
  // Script first seen -> Debugger.scriptParsed (drives setBreakpointByUrl).
  engineDbg->setScriptParsedNotifier(
      [adapterRaw, tenantId](const rill::devtools::ScriptInfo& info) {
        adapterRaw->onScriptParsed(tenantId, info);
      });
  return target;
}
#endif

void QuickJSSandboxContext::installConsole() {
  const char *consoleScript = R"(
        var console = {
            log: function() {
                var args = Array.prototype.slice.call(arguments);
                __qjs_print(args.map(function(a) {
                    if (typeof a === 'object') return JSON.stringify(a);
                    return String(a);
                }).join(' '));
            },
            warn: function() { console.log('[WARN]', ...arguments); },
            error: function() { console.log('[ERROR]', ...arguments); },
            info: function() { console.log('[INFO]', ...arguments); },
            debug: function() { console.log('[DEBUG]', ...arguments); },
            assert: function(cond) { if (!cond) console.log('[ASSERT]', ...Array.prototype.slice.call(arguments, 1)); },
            trace: function() {},
            time: function() {},
            timeEnd: function() {},
            group: function() {},
            groupEnd: function() {}
        };
    )";

  // Install native print function
  JSValue global = JS_GetGlobalObject(qjsContext_);

  auto printFunc = [](JSContext *ctx, JSValueConst, int argc,
                      JSValueConst *argv) -> JSValue {
    for (int i = 0; i < argc; i++) {
      const char *str = JS_ToCString(ctx, argv[i]);
      if (str) {
        // Forward sandbox console.log to host's OutputDebugString
#ifdef _WIN32
        OutputDebugStringA("[QuickJSSandbox] ");
        OutputDebugStringA(str);
        OutputDebugStringA("\n");
#endif
        JS_FreeCString(ctx, str);
      }
    }
    return JS_UNDEFINED;
  };

  JSValue printFn = JS_NewCFunction(qjsContext_, printFunc, "__qjs_print", 1);
  JS_SetPropertyStr(qjsContext_, global, "__qjs_print", printFn);

  JS_FreeValue(qjsContext_, global);

  // Run console setup script
  JSValue result = JS_Eval(qjsContext_, consoleScript, strlen(consoleScript),
                           "<console>", JS_EVAL_TYPE_GLOBAL);
  JS_FreeValue(qjsContext_, result);
}

void QuickJSSandboxContext::checkException() {
  JSValue exception = JS_GetException(qjsContext_);
  if (!JS_IsNull(exception) && !JS_IsUndefined(exception)) {
    const char *str = JS_ToCString(qjsContext_, exception);
    std::string errorMsg = str ? str : "Unknown error";
    if (str)
      JS_FreeCString(qjsContext_, str);
    JS_FreeValue(qjsContext_, exception);
    throw jsi::JSError(*hostRuntime_, errorMsg);
  }
  JS_FreeValue(qjsContext_, exception);
}

jsi::Value QuickJSSandboxContext::get(jsi::Runtime &rt,
                                      const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "eval") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          try {
            if (count < 1 || !args[0].isString()) {
              throw jsi::JSError(rt, "eval requires a string argument");
            }
            std::string code = args[0].asString(rt).utf8(rt);
            return this->eval(rt, code);
          } catch (const jsi::JSError &) {
            throw;
          } catch (const std::exception &e) {
            throw jsi::JSError(rt, std::string("eval lambda: ") + e.what());
          } catch (...) {
            throw jsi::JSError(rt, "eval lambda: unknown exception");
          }
        });
  }

  if (propName == "inject") {
    return jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 2 || !args[0].isString()) {
            throw jsi::JSError(rt,
                               "inject requires (name: string, value: any)");
          }
          std::string globalName = args[0].asString(rt).utf8(rt);
          this->inject(rt, globalName, args[1]);
          return jsi::Value::undefined();
        });
  }

  if (propName == "extract") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 1 || !args[0].isString()) {
            throw jsi::JSError(rt, "extract requires a string argument");
          }
          std::string globalName = args[0].asString(rt).utf8(rt);
          return this->extract(rt, globalName);
        });
  }

  if (propName == "dispose") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &, const jsi::Value &, const jsi::Value *,
               size_t) -> jsi::Value {
          this->dispose();
          return jsi::Value::undefined();
        });
  }

  if (propName == "isDisposed") {
    return jsi::Value(disposed_);
  }

  return jsi::Value::undefined();
}

void QuickJSSandboxContext::set(jsi::Runtime &, const jsi::PropNameID &,
                                const jsi::Value &) {
  // Read-only
}

std::vector<jsi::PropNameID>
QuickJSSandboxContext::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "eval"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "inject"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "extract"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "isDisposed"));
  return props;
}

jsi::Value QuickJSSandboxContext::eval(jsi::Runtime &rt,
                                       const std::string &code) {
  try {
    std::lock_guard<std::recursive_mutex> lock(mutex_);

    if (disposed_) {
      throw jsi::JSError(rt, "Context has been disposed");
    }

    // Arm the wall-clock execution deadline for this top-level eval.
    // The runtime-level interrupt handler (see QuickJSSandboxRuntime ctor)
    // aborts JS execution once the deadline passes. No-op when
    // timeoutMs_ <= 0 (unlimited) or when an outer deadline is already
    // active (nested re-entry through a host callback).
    DeadlineGuard deadline(interruptState_.get(), timeoutMs_);

    JSValue result = JS_Eval(qjsContext_, code.c_str(), code.size(), "<eval>",
                             JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(result)) {
      JSValue exception = JS_GetException(qjsContext_);
      const char *str = JS_ToCString(qjsContext_, exception);
      std::string errorMsg = str ? str : "Unknown error";
      if (str)
        JS_FreeCString(qjsContext_, str);
      JS_FreeValue(qjsContext_, exception);
      JS_FreeValue(qjsContext_, result);
      if (deadline.timedOut()) {
        throw jsi::JSError(
            rt, "QuickJS eval timed out after " +
                    std::to_string(static_cast<long long>(timeoutMs_)) +
                    "ms (execution interrupted)");
      }
      throw jsi::JSError(rt, errorMsg);
    }

    JSContext *jobCtx = nullptr;
    int executedJobs = 0;
    for (;;) {
      int ret = JS_ExecutePendingJob(qjsRuntime_, &jobCtx);
      if (ret == 0) {
        break;
      }
      if (ret < 0) {
        std::string errorMsg = "QuickJS pending job failed";
        if (jobCtx) {
          JSValue exception = JS_GetException(jobCtx);
          const char *str = JS_ToCString(jobCtx, exception);
          if (str) {
            errorMsg = str;
            JS_FreeCString(jobCtx, str);
          }
          JS_FreeValue(jobCtx, exception);
        }
        JS_FreeValue(qjsContext_, result);
        if (deadline.timedOut()) {
          throw jsi::JSError(
              rt, "QuickJS eval timed out after " +
                      std::to_string(static_cast<long long>(timeoutMs_)) +
                      "ms (pending job interrupted)");
        }
        throw jsi::JSError(rt, errorMsg);
      }
      executedJobs++;
      if (executedJobs > 1000) {
        JS_FreeValue(qjsContext_, result);
        throw jsi::JSError(rt, "QuickJS pending job drain exceeded safety limit");
      }
    }

    jsi::Value jsiResult = qjsToJSI(rt, result);
    JS_FreeValue(qjsContext_, result);
    return jsiResult;
  } catch (const jsi::JSError &) {
    throw; // Re-throw JSI errors as-is
  } catch (const std::exception &e) {
    throw jsi::JSError(rt, std::string("eval error: ") + e.what());
  } catch (...) {
    throw jsi::JSError(rt, "eval error: unknown non-std exception");
  }
}

// Static callback for host functions
JSValue QuickJSSandboxContext::hostFunctionCallback(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv,
    int magic, JSValue *func_data) {
  (void)this_val;
  (void)magic;

  // func_data[0] contains a pointer to HostFunctionData
  HostFunctionData *data = static_cast<HostFunctionData *>(
      JS_GetOpaque(func_data[0], hostFunctionDataClassID_));
  if (!data || !data->self || !data->func) {
    return JS_ThrowInternalError(ctx, "Invalid host function data");
  }

  auto *self = data->self;
  jsi::Runtime *hostRt = self->hostRuntime_;

  try {
    std::vector<jsi::Value> jsiArgs;
    for (int i = 0; i < argc; i++) {
      // argv[i] is borrowed, no need to dup - qjsToJSI reads without consuming
      jsiArgs.push_back(self->qjsToJSI(*hostRt, argv[i]));
    }

    jsi::Value result;
    if (jsiArgs.empty()) {
      result = data->func->call(*hostRt);
    } else {
      result = data->func->call(*hostRt, (const jsi::Value *)jsiArgs.data(),
                                jsiArgs.size());
    }

    return self->jsiToQJS(*hostRt, result);
  } catch (const std::exception &e) {
    return JS_ThrowInternalError(ctx, "%s", e.what());
  }
}

void QuickJSSandboxContext::inject(jsi::Runtime &rt, const std::string &name,
                                      const jsi::Value &value) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  JSValue global = JS_GetGlobalObject(qjsContext_);
  JSValue qjsValue = jsiToQJS(rt, value);
  JS_SetPropertyStr(qjsContext_, global, name.c_str(), qjsValue);
  JS_FreeValue(qjsContext_, global);
}

jsi::Value QuickJSSandboxContext::extract(jsi::Runtime &rt,
                                            const std::string &name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  JSValue global = JS_GetGlobalObject(qjsContext_);
  JSValue value = JS_GetPropertyStr(qjsContext_, global, name.c_str());
  JS_FreeValue(qjsContext_, global);

  jsi::Value result = qjsToJSI(rt, value);
  JS_FreeValue(qjsContext_, value);
  return result;
}

JSValue QuickJSSandboxContext::wrapFunctionForSandbox(jsi::Runtime &rt,
                                                      jsi::Function &&func) {
  jsi::Object funcObj = std::move(func); // Treat as object to access properties
  
  // 1. Try to retrieve existing Proxy ID from the function object (identity caching)
  std::string existingId;
  bool isCached = false;
  
  try {
    if (funcObj.hasProperty(rt, "__rill_proxy_id__")) {
      jsi::Value idVal = funcObj.getProperty(rt, "__rill_proxy_id__");
      if (idVal.isString()) {
        existingId = idVal.asString(rt).utf8(rt);
        std::string callbackId = "cb_" + existingId;
        
        // Check if this ID exists in our callback map
        auto it = callbacks_.find(callbackId);
        if (it != callbacks_.end()) {
          isCached = true;
          // Check if we have a cached wrapper
          auto wrapperIt = wrapperCache_.find(callbackId);
          if (wrapperIt != wrapperCache_.end()) {
            // Return duplicated reference to cached wrapper
            return JS_DupValue(qjsContext_, wrapperIt->second);
          }
          // Wrapper was collected but callback still exists - fallthrough to recreate
        }
      }
    }
  } catch (...) {
    // Ignore errors reading property
  }
  
  // 2. Generate new ID if not cached
  std::string callbackId;
  if (isCached) {
    callbackId = "cb_" + existingId;
  } else {
    std::string idStr = std::to_string(++callbackCounter_);
    callbackId = "cb_" + idStr;
    
    // Tag the original function with the ID for future identity checks
    try {
      funcObj.setProperty(rt, "__rill_proxy_id__", jsi::String::createFromUtf8(rt, idStr));
    } catch (...) {
      // Failed to tag, continue anyway
    }
  }
  
  // Convert back to function
  jsi::Function funcToStore = funcObj.asFunction(rt);
  
  // Store the function
  auto funcPtr = std::make_shared<jsi::Function>(std::move(funcToStore));
  callbacks_[callbackId] = funcPtr;

  // Create HostFunctionData
  auto *data = new HostFunctionData{this, funcPtr, callbackId};

  // Create an opaque JS object to hold the data pointer (with our registered
  // class that has finalizer)
  JSValue dataObj = JS_NewObjectClass(qjsContext_, hostFunctionDataClassID_);
  JS_SetOpaque(dataObj, data);

  // Create the function with data
  JSValue funcVal = JS_NewCFunctionData(qjsContext_, hostFunctionCallback,
                                        0, // length
                                        0, // magic
                                        1, // data_len
                                        &dataObj);

  JS_FreeValue(qjsContext_, dataObj);
  
  // Cache the wrapper for identity preservation
  wrapperCache_[callbackId] = JS_DupValue(qjsContext_, funcVal);
  
  return funcVal;
}

// Convert jsi::Value to QuickJS JSValue
JSValue QuickJSSandboxContext::jsiToQJS(jsi::Runtime &rt,
                                        const jsi::Value &value, int depth) {
  static constexpr int kMaxDepth = 100;
  if (depth > kMaxDepth) {
    return JS_NewStringLen(qjsContext_,
        "[jsiToQJS: max depth exceeded]", 30);
  }

  if (value.isUndefined()) {
    return JS_UNDEFINED;
  }
  if (value.isNull()) {
    return JS_NULL;
  }
  if (value.isBool()) {
    return JS_NewBool(qjsContext_, value.getBool());
  }
  if (value.isNumber()) {
    return JS_NewFloat64(qjsContext_, value.getNumber());
  }
  if (value.isString()) {
    std::string str = value.asString(rt).utf8(rt);
    return JS_NewStringLen(qjsContext_, str.c_str(), str.size());
  }
  if (value.isSymbol()) {
    // QuickJS doesn't expose JS_NewSymbol publicly
    // Convert symbol to its description string for now
    jsi::Symbol sym = value.getSymbol(rt);
    std::string symDesc = sym.toString(rt);
    return JS_NewStringLen(qjsContext_, symDesc.c_str(), symDesc.size());
  }
  if (value.isObject()) {
    jsi::Object obj = value.asObject(rt);

    // Handle functions
    if (obj.isFunction(rt)) {
      jsi::Function func = obj.asFunction(rt);
      return wrapFunctionForSandbox(rt, std::move(func));
    }

    // Handle arrays
    if (obj.isArray(rt)) {
      jsi::Array arr = obj.asArray(rt);
      size_t len = arr.size(rt);
      JSValue jsArr = JS_NewArray(qjsContext_);
      for (size_t i = 0; i < len; i++) {
        JSValue elem = jsiToQJS(rt, arr.getValueAtIndex(rt, i), depth + 1);
        JS_SetPropertyUint32(qjsContext_, jsArr, (uint32_t)i, elem);
      }
      return jsArr;
    }

    // Handle plain objects
    jsi::Array propNames = obj.getPropertyNames(rt);
    size_t len = propNames.size(rt);
    JSValue jsObj = JS_NewObject(qjsContext_);
    for (size_t i = 0; i < len; i++) {
      std::string key = propNames.getValueAtIndex(rt, i).asString(rt).utf8(rt);
      jsi::Value propVal = obj.getProperty(rt, key.c_str());
      JSValue qjsVal = jsiToQJS(rt, propVal, depth + 1);
      JS_SetPropertyStr(qjsContext_, jsObj, key.c_str(), qjsVal);
    }
    return jsObj;
  }

  return JS_UNDEFINED;
}

// Convert QuickJS JSValue to jsi::Value
jsi::Value QuickJSSandboxContext::qjsToJSI(jsi::Runtime &rt, JSValue value,
                                           int depth) {
  // Guard against stack overflow from deeply nested or circular objects.
  // Android native thread stack is typically 1MB; each recursive frame uses
  // ~200-400 bytes, so 100 levels (~40KB) is safe with generous margin.
  static constexpr int kMaxDepth = 100;
  if (depth > kMaxDepth) {
    return jsi::String::createFromUtf8(
        rt, "[qjsToJSI: max depth exceeded — possible circular reference]");
  }

  if (JS_IsUndefined(value)) {
    return jsi::Value::undefined();
  }
  if (JS_IsNull(value)) {
    return jsi::Value::null();
  }
  if (JS_IsBool(value)) {
    return jsi::Value(JS_ToBool(qjsContext_, value) != 0);
  }
  if (JS_IsNumber(value)) {
    double num;
    JS_ToFloat64(qjsContext_, &num, value);
    return jsi::Value(num);
  }
  if (JS_IsString(value)) {
    const char *str = JS_ToCString(qjsContext_, value);
    jsi::String jsiStr = jsi::String::createFromUtf8(rt, str ? str : "");
    if (str)
      JS_FreeCString(qjsContext_, str);
    return jsiStr;
  }
  if (JS_IsSymbol(value)) {
    // JSI doesn't have a direct way to create symbols from C++
    // Return as string description
    JSAtom atom = JS_ValueToAtom(qjsContext_, value);
    const char *str = JS_AtomToCString(qjsContext_, atom);
    std::string symStr = str ? str : "Symbol()";
    if (str)
      JS_FreeCString(qjsContext_, str);
    JS_FreeAtom(qjsContext_, atom);
    return jsi::String::createFromUtf8(rt, symStr);
  }
  if (JS_IsArray(qjsContext_, value)) {
    JSValue lengthVal = JS_GetPropertyStr(qjsContext_, value, "length");
    uint32_t length;
    JS_ToUint32(qjsContext_, &length, lengthVal);
    JS_FreeValue(qjsContext_, lengthVal);

    jsi::Array arr = jsi::Array(rt, length);
    for (uint32_t i = 0; i < length; i++) {
      JSValue elem = JS_GetPropertyUint32(qjsContext_, value, i);
      arr.setValueAtIndex(rt, i, qjsToJSI(rt, elem, depth + 1));
      JS_FreeValue(qjsContext_, elem);
    }
    return std::move(arr);
  }
  if (JS_IsFunction(qjsContext_, value)) {
    // Store the sandbox function
    std::string funcKey =
        "__sandbox_fn_" + std::to_string(++g_sandboxFuncCounter) + "__";

    // Store function in global scope for later retrieval
    JSValue global = JS_GetGlobalObject(qjsContext_);
    JS_SetPropertyStr(qjsContext_, global, funcKey.c_str(),
                      JS_DupValue(qjsContext_, value));
    JS_FreeValue(qjsContext_, global);

    auto *self = this;
    std::string capturedKey = funcKey;

    // Create a JSI host function that proxies calls to the sandbox function
    return jsi::Function::createFromHostFunction(
        rt, jsi::PropNameID::forUtf8(rt, "sandboxProxy"), 0,
        [self, capturedKey](jsi::Runtime &rt, const jsi::Value &,
                            const jsi::Value *args,
                            size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(self->mutex_);

          if (self->disposed_) {
            throw jsi::JSError(rt, "Context has been disposed");
          }

          JSValue global = JS_GetGlobalObject(self->qjsContext_);
          JSValue sandboxFunc =
              JS_GetPropertyStr(self->qjsContext_, global, capturedKey.c_str());
          JS_FreeValue(self->qjsContext_, global);

          if (JS_IsUndefined(sandboxFunc)) {
            throw jsi::JSError(rt, "Sandbox function not found");
          }

          // Convert args
          std::vector<JSValue> qjsArgs;
          for (size_t i = 0; i < count; i++) {
            qjsArgs.push_back(self->jsiToQJS(rt, args[i]));
          }

          // Sandbox code also runs here (host invoking a tenant function),
          // so the same wall-clock deadline applies as for eval().
          DeadlineGuard deadline(self->interruptState_.get(),
                                 self->timeoutMs_);

          JSValue result = JS_Call(self->qjsContext_, sandboxFunc, JS_UNDEFINED,
                                   (int)count, qjsArgs.data());

          // Free args
          for (auto &arg : qjsArgs) {
            JS_FreeValue(self->qjsContext_, arg);
          }
          JS_FreeValue(self->qjsContext_, sandboxFunc);

          if (JS_IsException(result)) {
            JSValue exception = JS_GetException(self->qjsContext_);
            const char *str = JS_ToCString(self->qjsContext_, exception);
            std::string errorMsg = str ? str : "Unknown error";
            if (str)
              JS_FreeCString(self->qjsContext_, str);
            JS_FreeValue(self->qjsContext_, exception);
            JS_FreeValue(self->qjsContext_, result);
            if (deadline.timedOut()) {
              throw jsi::JSError(
                  rt, "QuickJS sandbox function timed out after " +
                          std::to_string(
                              static_cast<long long>(self->timeoutMs_)) +
                          "ms (execution interrupted)");
            }
            throw jsi::JSError(rt, errorMsg);
          }

          jsi::Value jsiResult = self->qjsToJSI(rt, result, 0);
          JS_FreeValue(self->qjsContext_, result);
          return jsiResult;
        });
  }
  if (JS_IsObject(value)) {
    jsi::Object jsiObj = jsi::Object(rt);

    // Get property names
    JSPropertyEnum *props;
    uint32_t propCount;
    if (JS_GetOwnPropertyNames(qjsContext_, &props, &propCount, value,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
      for (uint32_t i = 0; i < propCount; i++) {
        const char *key = JS_AtomToCString(qjsContext_, props[i].atom);
        if (key) {
          JSValue propVal = JS_GetProperty(qjsContext_, value, props[i].atom);
          jsiObj.setProperty(rt, key, qjsToJSI(rt, propVal, depth + 1));
          JS_FreeValue(qjsContext_, propVal);
          JS_FreeCString(qjsContext_, key);
        }
        JS_FreeAtom(qjsContext_, props[i].atom);
      }
      js_free(qjsContext_, props);
    }

    return std::move(jsiObj);
  }

  return jsi::Value::undefined();
}

// MARK: - QuickJSSandboxRuntime Implementation

QuickJSSandboxRuntime::QuickJSSandboxRuntime(jsi::Runtime &hostRuntime,
                                             double timeout,
                                             double maxHeapBytes)
    : qjsRuntime_(nullptr), hostRuntime_(&hostRuntime), timeout_(timeout),
      interruptState_(std::make_shared<InterruptState>()), disposed_(false) {
  qjsRuntime_ = JS_NewRuntime();
  if (!qjsRuntime_) {
    throw jsi::JSError(hostRuntime, "Failed to create QuickJS runtime");
  }

  // Wall-clock watchdog: QuickJS polls this handler periodically while JS
  // executes. Returning 1 aborts execution with an "interrupted" exception,
  // which eval()/sandbox function calls translate into a clear timeout error
  // when their DeadlineGuard armed the deadline. This is what makes
  // createRuntime({timeout}) an enforced limit rather than a suggestion:
  // a tenant `while(true){}` no longer hangs the host thread forever.
  JS_SetInterruptHandler(
      qjsRuntime_,
      [](JSRuntime *, void *opaque) -> int {
        auto *state = static_cast<InterruptState *>(opaque);
        if (!state->armed.load(std::memory_order_acquire)) {
          return 0;
        }
        int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now().time_since_epoch())
                          .count();
        if (now >= state->deadlineMs.load(std::memory_order_relaxed)) {
          state->fired.store(true, std::memory_order_release);
          return 1; // interrupt JS execution
        }
        return 0;
      },
      interruptState_.get());

  // Match the reference QuickJSRuntime defaults used elsewhere in the repo.
  // These settings shouldn't be required, but they help avoid runtime-specific
  // edge cases and keep behavior consistent.
#ifdef _WIN32
  // WindowsDemo.vcxproj reserves 8MB thread stack. Give QuickJS 4MB so
  // CONFIG_STACK_CHECK fires before hitting the OS guard page, while
  // leaving ~4MB headroom for host frames above QuickJS.
  JS_SetMaxStackSize(qjsRuntime_, 4 * 1024 * 1024); // 4MB
#else
  JS_SetMaxStackSize(qjsRuntime_, 1024 * 1024 * 1024); // 1GB
#endif
  JS_SetCanBlock(qjsRuntime_, true);
  JS_SetRuntimeInfo(qjsRuntime_, "RillQuickJSSandbox");

  // Heap limit: the tenant quota when provided, the 256MB default otherwise.
  // Guard the double->size_t cast (Infinity / oversized values are UB to
  // cast): anything not representable falls back to the default.
  constexpr double kMaxRepresentableHeap = 1.0e18; // < SIZE_MAX on 64-bit
  size_t heapLimit = 256 * 1024 * 1024; // 256MB default
  if (maxHeapBytes >= 1 && maxHeapBytes < kMaxRepresentableHeap) {
    heapLimit = static_cast<size_t>(maxHeapBytes);
  }
  JS_SetMemoryLimit(qjsRuntime_, heapLimit);
}

QuickJSSandboxRuntime::~QuickJSSandboxRuntime() { dispose(); }

void QuickJSSandboxRuntime::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  // Drain pending jobs (promises, etc.) before tearing down contexts/runtime.
  // This mirrors QuickJSRuntime::~QuickJSRuntime() and avoids freeing a runtime
  // while jobs are still queued. The drain MUST be bounded (same cap as the
  // eval-path drain): a tenant can enqueue a self-requeueing promise job
  // (`function f(){Promise.resolve().then(f)}`) that survives an eval timeout,
  // and an unbounded loop here would hang the host thread in dispose()
  // forever — the interrupt handler does not run while no deadline is armed.
  // Leftover jobs are safe to drop: JS_FreeRuntime frees the queued job list.
  if (qjsRuntime_) {
    int executedJobs = 0;
    for (;;) {
      JSContext *ctx1 = nullptr;
      int ret = JS_ExecutePendingJob(qjsRuntime_, &ctx1);
      if (ret == 0) {
        break;
      }
      if (ret < 0) {
        // Best-effort: clear the exception and keep draining remaining jobs.
        if (ctx1) {
          JSValue exception = JS_GetException(ctx1);
          JS_FreeValue(ctx1, exception);
        }
      }
      executedJobs++;
      if (executedJobs > 1000) {
        break;
      }
    }
  }

  for (auto &ctx : contexts_) {
    ctx->dispose();
  }
  contexts_.clear();

  if (qjsRuntime_) {
    JS_FreeRuntime(qjsRuntime_);
    qjsRuntime_ = nullptr;
  }
}

jsi::Value QuickJSSandboxRuntime::get(jsi::Runtime &rt,
                                      const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createContext") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *,
               size_t) -> jsi::Value { return this->createContext(rt); });
  }

  if (propName == "dispose") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &, const jsi::Value &, const jsi::Value *,
               size_t) -> jsi::Value {
          this->dispose();
          return jsi::Value::undefined();
        });
  }

  return jsi::Value::undefined();
}

void QuickJSSandboxRuntime::set(jsi::Runtime &, const jsi::PropNameID &,
                                const jsi::Value &) {
  // Read-only
}

std::vector<jsi::PropNameID>
QuickJSSandboxRuntime::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createContext"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  return props;
}

jsi::Value QuickJSSandboxRuntime::createContext(jsi::Runtime &rt) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Runtime has been disposed");
  }

  auto context = std::make_shared<QuickJSSandboxContext>(
      *hostRuntime_, qjsRuntime_, timeout_, interruptState_);
  contexts_.push_back(context);

  return jsi::Object::createFromHostObject(rt, context);
}

// MARK: - QuickJSSandboxModule Implementation

QuickJSSandboxModule::QuickJSSandboxModule(jsi::Runtime &) {}

QuickJSSandboxModule::~QuickJSSandboxModule() {}

jsi::Value QuickJSSandboxModule::get(jsi::Runtime &rt,
                                     const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createRuntime") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
           size_t count) -> jsi::Value {
          double timeout = 30000;   // default 30s
          double maxHeapBytes = 0;  // <= 0: default heap limit (256MB)

          if (count > 0 && args[0].isObject()) {
            jsi::Object opts = args[0].asObject(rt);
            if (opts.hasProperty(rt, "timeout")) {
              jsi::Value timeoutVal = opts.getProperty(rt, "timeout");
              if (timeoutVal.isNumber()) {
                timeout = timeoutVal.getNumber();
              }
            }
            if (opts.hasProperty(rt, "maxHeapBytes")) {
              jsi::Value heapVal = opts.getProperty(rt, "maxHeapBytes");
              if (heapVal.isNumber()) {
                maxHeapBytes = heapVal.getNumber();
              }
            }
          }

          auto runtime =
              std::make_shared<QuickJSSandboxRuntime>(rt, timeout, maxHeapBytes);
          return jsi::Object::createFromHostObject(rt, runtime);
        });
  }

  if (propName == "isAvailable") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [](jsi::Runtime &, const jsi::Value &, const jsi::Value *,
           size_t) -> jsi::Value { return jsi::Value(true); });
  }

  return jsi::Value::undefined();
}

void QuickJSSandboxModule::set(jsi::Runtime &, const jsi::PropNameID &,
                               const jsi::Value &) {
  // Read-only
}

std::vector<jsi::PropNameID>
QuickJSSandboxModule::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createRuntime"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "isAvailable"));
  return props;
}

void QuickJSSandboxModule::install(jsi::Runtime &runtime) {
  auto module = std::make_shared<QuickJSSandboxModule>(runtime);
  jsi::Object moduleObj = jsi::Object::createFromHostObject(runtime, module);
  runtime.global().setProperty(runtime, "__QuickJSSandboxJSI",
                               std::move(moduleObj));
#ifdef _WIN32
  OutputDebugStringA("[QuickJSSandbox] Installed __QuickJSSandboxJSI\n");
#endif
}

// Wrapper function for external linkage (avoids JSValue symbol conflicts)
void installQuickJSSandbox(jsi::Runtime &runtime) {
  QuickJSSandboxModule::install(runtime);
}

} // namespace quickjs_sandbox
