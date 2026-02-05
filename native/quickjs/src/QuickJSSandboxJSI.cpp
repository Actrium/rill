#include "QuickJSSandboxJSI.h"
#include <cstring>
#include <iostream>
#include <sstream>

namespace quickjs_sandbox {

// Static counter for sandbox functions
static int g_sandboxFuncCounter = 0;

// Static members for HostFunctionData class
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

QuickJSSandboxContext::QuickJSSandboxContext(jsi::Runtime &hostRuntime,
                                             JSRuntime *qjsRuntime,
                                             double /* timeout */)
    : qjsContext_(nullptr), qjsRuntime_(qjsRuntime), hostRuntime_(&hostRuntime),
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

  if (qjsContext_) {
    JS_FreeContext(qjsContext_);
    qjsContext_ = nullptr;
  }
}

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
        std::cout << "[QuickJSSandbox] " << str << std::endl;
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
          if (count < 1 || !args[0].isString()) {
            throw jsi::JSError(rt, "eval requires a string argument");
          }
          std::string code = args[0].asString(rt).utf8(rt);
          return this->eval(rt, code);
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
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

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
    throw jsi::JSError(rt, errorMsg);
  }

  jsi::Value jsiResult = qjsToJSI(rt, result);
  JS_FreeValue(qjsContext_, result);
  return jsiResult;
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
                                             double timeout)
    : qjsRuntime_(nullptr), hostRuntime_(&hostRuntime), timeout_(timeout),
      disposed_(false) {
  qjsRuntime_ = JS_NewRuntime();
  if (!qjsRuntime_) {
    throw jsi::JSError(hostRuntime, "Failed to create QuickJS runtime");
  }

  // Match the reference QuickJSRuntime defaults used elsewhere in the repo.
  // These settings shouldn't be required, but they help avoid runtime-specific
  // edge cases and keep behavior consistent.
  JS_SetMaxStackSize(qjsRuntime_, 1024 * 1024 * 1024); // 1GB
  JS_SetCanBlock(qjsRuntime_, true);
  JS_SetRuntimeInfo(qjsRuntime_, "RillQuickJSSandbox");

  // Set memory limit (optional)
  JS_SetMemoryLimit(qjsRuntime_, 256 * 1024 * 1024); // 256MB
}

QuickJSSandboxRuntime::~QuickJSSandboxRuntime() { dispose(); }

void QuickJSSandboxRuntime::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  // Drain pending jobs (promises, etc.) before tearing down contexts/runtime.
  // This mirrors QuickJSRuntime::~QuickJSRuntime() and avoids freeing a runtime
  // while jobs are still queued.
  if (qjsRuntime_) {
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

  auto context = std::make_shared<QuickJSSandboxContext>(*hostRuntime_,
                                                         qjsRuntime_, timeout_);
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
          double timeout = 30000; // default 30s

          if (count > 0 && args[0].isObject()) {
            jsi::Object opts = args[0].asObject(rt);
            if (opts.hasProperty(rt, "timeout")) {
              jsi::Value timeoutVal = opts.getProperty(rt, "timeout");
              if (timeoutVal.isNumber()) {
                timeout = timeoutVal.getNumber();
              }
            }
          }

          auto runtime = std::make_shared<QuickJSSandboxRuntime>(rt, timeout);
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
  std::cout << "[QuickJSSandbox] Installed __QuickJSSandboxJSI" << std::endl;
}

// Wrapper function for external linkage (avoids JSValue symbol conflicts)
void installQuickJSSandbox(jsi::Runtime &runtime) {
  QuickJSSandboxModule::install(runtime);
}

} // namespace quickjs_sandbox
