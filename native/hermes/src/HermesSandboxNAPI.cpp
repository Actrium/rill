// HermesSandboxNAPI.cpp - Hermes sandbox adapter using N-API (C interface).
//
// PURPOSE:
//   On Windows, the Hermes NuGet package (Microsoft.JavaScript.Hermes) only
//   exports N-API/JSR C functions (jsr_create_runtime, napi_*). It does NOT
//   ship the C++ JSI headers (hermes/hermes.h, makeHermesRuntime) used by
//   HermesSandboxJSI.cpp (the iOS/Android/macOS variant).
//
//   This file provides the same JSI HostObject interface (__HermesSandboxJSI)
//   but internally creates and drives the sandbox Hermes runtime through the
//   N-API C surface.
//
// WHEN TO USE WHICH:
//   HermesSandboxJSI.cpp  - platforms with hermes/hermes.h (iOS, Android, macOS)
//   HermesSandboxNAPI.cpp - platforms with N-API-only Hermes (Windows NuGet)
//
// Both expose identical JS-visible API:
//   global.__HermesSandboxJSI.createRuntime() -> .createContext() -> .eval() etc.

#include "HermesSandboxNAPI.h"

// N-API / JSR headers from the Hermes NuGet package
#include <hermes/js_runtime_api.h>

#include <cstring>
#include <fstream>
#include <string>
#include <sstream>
#include <cstdint>
#include <vector>

#ifdef _WIN32
#include <windows.h>
static void rill_napi_log(const char *tag, const std::string &msg) {
  std::string out = "[" + std::string(tag) + "] " + msg + "\n";
  OutputDebugStringA(out.c_str());
}
#else
#include <cstdio>
static void rill_napi_log(const char *tag, const std::string &msg) {
  fprintf(stderr, "[%s] %s\n", tag, msg.c_str());
}
#endif

static const char *kLogTag = "HermesSandboxNAPI";

#ifdef _WIN32
static std::string dirnameOfExe() {
  char exePath[MAX_PATH] = {0};
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

static std::string resolveAssetPath(const std::string &inputPath) {
  std::string p = normalizeSlashes(inputPath);
  if (p.empty()) return "";
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
#else
static std::string resolveAssetPath(const std::string &inputPath) {
  return inputPath;
}
#endif

static bool readBinaryFile(const std::string &path, std::vector<uint8_t> &out) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f.is_open()) return false;
  std::streamsize sz = f.tellg();
  if (sz <= 0) return false;
  f.seekg(0, std::ios::beg);
  out.resize(static_cast<size_t>(sz));
  return static_cast<bool>(f.read(reinterpret_cast<char *>(out.data()), sz));
}

static void drainAllMicrotasks(napi_env env) {
  // JSR exposes explicit microtask draining; run until queue is empty
  // to ensure render/effect pipelines can flush in the sandbox runtime.
  bool didRun = false;
  int guard = 0;
  do {
    didRun = false;
    if (jsr_drain_microtasks(env, INT32_MAX, &didRun) != napi_ok) {
      break;
    }
    guard++;
  } while (didRun && guard < 1024);
}

// Helper: check napi_status and throw on failure
#define NAPI_CHECK(env, expr)                                                  \
  do {                                                                         \
    napi_status _s = (expr);                                                   \
    if (_s != napi_ok) {                                                       \
      rill_napi_log(kLogTag, std::string(#expr) + " failed: " +               \
                                 std::to_string(static_cast<int>(_s)));        \
    }                                                                          \
  } while (0)

// Helper: get a UTF-8 string from a napi_value
static std::string napiStringToUtf8(napi_env env, napi_value val) {
  size_t len = 0;
  napi_get_value_string_utf8(env, val, nullptr, 0, &len);
  std::string result(len, '\0');
  napi_get_value_string_utf8(env, val, &result[0], len + 1, &len);
  return result;
}

namespace hermes_sandbox_napi {

// ============================================================================
// EnvScope - RAII guard for jsr_napi_env_scope
// ============================================================================

HermesSandboxNAPIContext::EnvScope::EnvScope(napi_env e) : env(e) {
  napi_status s = jsr_open_napi_env_scope(env, &scope);
  if (s != napi_ok) {
    scope = nullptr;
    rill_napi_log(kLogTag, "EnvScope: jsr_open_napi_env_scope FAILED: " +
                  std::to_string(static_cast<int>(s)));
  }
}

HermesSandboxNAPIContext::EnvScope::~EnvScope() {
  if (scope) {
    jsr_close_napi_env_scope(env, scope);
    scope = nullptr;
  }
}

// ============================================================================
// HermesSandboxNAPIContext
// ============================================================================

HermesSandboxNAPIContext::HermesSandboxNAPIContext(jsi::Runtime &hostRuntime,
                                                   double timeout)
    : runtime_(nullptr), env_(nullptr),
      hostRuntime_(&hostRuntime), disposed_(false) {
  // NOT ENFORCED: the Hermes N-API surface exposes no interrupt/watchdog
  // hook, so the createRuntime({timeout}) option is accepted but ignored
  // here. A tenant infinite loop will block the calling (host) thread
  // indefinitely. (The C++ JSI variant, HermesSandboxJSI, DOES enforce it
  // via HermesRuntime::watchTimeLimit.)
  (void)timeout;

  jsr_config config = nullptr;
  napi_status s;

  s = jsr_create_config(&config);
  if (s != napi_ok || !config) {
    throw jsi::JSError(hostRuntime, "Failed to create Hermes JSR config");
  }

  s = jsr_create_runtime(config, &runtime_);
  jsr_delete_config(config);
  if (s != napi_ok || !runtime_) {
    throw jsi::JSError(hostRuntime, "Failed to create Hermes JSR runtime");
  }

  s = jsr_runtime_get_node_api_env(runtime_, &env_);
  if (s != napi_ok || !env_) {
    jsr_delete_runtime(runtime_);
    runtime_ = nullptr;
    throw jsi::JSError(hostRuntime, "Failed to get napi_env from JSR runtime");
  }

  // Use a temporary scope for installConsole - do NOT keep scope open.
  {
    EnvScope scope(env_);
    if (!scope.ok()) {
      jsr_delete_runtime(runtime_);
      runtime_ = nullptr;
      env_ = nullptr;
      throw jsi::JSError(hostRuntime, "Failed to open napi_env scope");
    }
    installConsole();
  }
  // Scope is now closed - host Hermes TLS is restored.
  rill_napi_log(kLogTag, "Created new Hermes N-API sandbox context");
}

HermesSandboxNAPIContext::~HermesSandboxNAPIContext() { dispose(); }

void HermesSandboxNAPIContext::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  callbacks_.clear();

  // Release sandbox function references before destroying the runtime
  if (env_ && !sandboxFuncRefs_.empty()) {
    EnvScope scope(env_);
    if (scope.ok()) {
      for (auto ref : sandboxFuncRefs_) {
        napi_delete_reference(env_, ref);
      }
    }
  }
  sandboxFuncRefs_.clear();

  if (runtime_) {
    jsr_delete_runtime(runtime_);
    runtime_ = nullptr;
  }
  env_ = nullptr;
  rill_napi_log(kLogTag, "Disposed N-API sandbox context");
}

std::string HermesSandboxNAPIContext::getExceptionMessage() {
  if (!env_)
    return "unknown error (no env)";

  bool isPending = false;
  napi_is_exception_pending(env_, &isPending);
  if (!isPending)
    return "unknown error";

  napi_value exc;
  napi_get_and_clear_last_exception(env_, &exc);

  // Try to get .message property
  napi_value msgVal;
  napi_status s = napi_get_named_property(env_, exc, "message", &msgVal);
  if (s == napi_ok) {
    napi_valuetype type;
    napi_typeof(env_, msgVal, &type);
    if (type == napi_string) {
      return napiStringToUtf8(env_, msgVal);
    }
  }

  // Fallback: coerce to string
  napi_value strVal;
  s = napi_coerce_to_string(env_, exc, &strVal);
  if (s == napi_ok) {
    return napiStringToUtf8(env_, strVal);
  }

  return "unknown error";
}

// ---- Value conversion: JSI -> N-API ----

napi_value HermesSandboxNAPIContext::jsiToNapi(jsi::Runtime &rt,
                                               const jsi::Value &value,
                                               int depth) {
  if (depth > 32) {
    napi_value undef;
    napi_get_undefined(env_, &undef);
    return undef;
  }

  if (value.isUndefined()) {
    napi_value result;
    napi_get_undefined(env_, &result);
    return result;
  }
  if (value.isNull()) {
    napi_value result;
    napi_get_null(env_, &result);
    return result;
  }
  if (value.isBool()) {
    napi_value result;
    napi_get_boolean(env_, value.getBool(), &result);
    return result;
  }
  if (value.isNumber()) {
    napi_value result;
    napi_create_double(env_, value.getNumber(), &result);
    return result;
  }
  if (value.isString()) {
    std::string str = value.getString(rt).utf8(rt);
    napi_value result;
    napi_create_string_utf8(env_, str.c_str(), str.size(), &result);
    return result;
  }
  if (value.isObject()) {
    jsi::Object obj = value.getObject(rt);

    // Arrays
    if (obj.isArray(rt)) {
      jsi::Array arr = obj.getArray(rt);
      size_t len = arr.size(rt);
      napi_value napiArr;
      napi_create_array_with_length(env_, len, &napiArr);
      for (size_t i = 0; i < len; i++) {
        napi_value elem = jsiToNapi(rt, arr.getValueAtIndex(rt, i), depth + 1);
        napi_set_element(env_, napiArr, static_cast<uint32_t>(i), elem);
      }
      return napiArr;
    }

    // Functions - wrap as N-API callback
    if (obj.isFunction(rt)) {
      return wrapHostFunction(rt, obj.asFunction(rt));
    }

    // Plain objects
    napi_value napiObj;
    napi_create_object(env_, &napiObj);
    jsi::Array names = obj.getPropertyNames(rt);
    size_t len = names.size(rt);
    for (size_t i = 0; i < len; i++) {
      std::string key = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
      jsi::Value propVal = obj.getProperty(rt, key.c_str());
      napi_value napiVal = jsiToNapi(rt, propVal, depth + 1);
      napi_set_named_property(env_, napiObj, key.c_str(), napiVal);
    }
    return napiObj;
  }

  napi_value undef;
  napi_get_undefined(env_, &undef);
  return undef;
}

// ---- Value conversion: N-API -> JSI ----

// KNOWN GAP (Windows): unlike the JSI/JSC converters, this one has NO
// ArrayBuffer/TypedArray branch — a sandbox ArrayBuffer falls into the
// generic property copy and arrives host-side as an empty object, so binary
// wires (op-batch binaryEncoding) must stay gated OFF on this provider until
// a napi_get_arraybuffer_info / napi_get_typedarray_info branch lands and is
// verified on a Windows host.
jsi::Value HermesSandboxNAPIContext::napiToJsi(jsi::Runtime &rt,
                                               napi_value value, int depth) {
  if (depth > 32)
    return jsi::Value::undefined();
  if (!value)
    return jsi::Value::undefined();

  napi_valuetype type;
  napi_typeof(env_, value, &type);

  switch (type) {
  case napi_undefined:
    return jsi::Value::undefined();
  case napi_null:
    return jsi::Value::null();
  case napi_boolean: {
    bool b;
    napi_get_value_bool(env_, value, &b);
    return jsi::Value(b);
  }
  case napi_number: {
    double d;
    napi_get_value_double(env_, value, &d);
    return jsi::Value(d);
  }
  case napi_string: {
    std::string str = napiStringToUtf8(env_, value);
    return jsi::String::createFromUtf8(rt, str);
  }
  case napi_object: {
    // Check if array
    bool isArr = false;
    napi_is_array(env_, value, &isArr);
    if (isArr) {
      uint32_t len = 0;
      napi_get_array_length(env_, value, &len);
      jsi::Array arr(rt, len);
      for (uint32_t i = 0; i < len; i++) {
        napi_value elem;
        napi_get_element(env_, value, i, &elem);
        arr.setValueAtIndex(rt, i, napiToJsi(rt, elem, depth + 1));
      }
      return arr;
    }

    // Plain object
    jsi::Object obj(rt);
    napi_value propNames;
    napi_get_property_names(env_, value, &propNames);
    uint32_t len = 0;
    napi_get_array_length(env_, propNames, &len);
    for (uint32_t i = 0; i < len; i++) {
      napi_value key;
      napi_get_element(env_, propNames, i, &key);
      std::string keyStr = napiStringToUtf8(env_, key);
      napi_value propVal;
      napi_get_named_property(env_, value, keyStr.c_str(), &propVal);
      obj.setProperty(rt, keyStr.c_str(), napiToJsi(rt, propVal, depth + 1));
    }
    return obj;
  }
  case napi_function: {
    // Wrap sandbox N-API function as a callable host JSI HostFunction.
    // When called from host side, re-enters the sandbox (mutex + EnvScope),
    // converts JSI args → N-API, invokes the sandbox function, and converts
    // the result back to JSI.
    //
    // This is critical for setImmediate: React scheduler passes sandbox
    // callbacks to host-side setImmediate, which must call them back later
    // during _drainPendingImmediates().
    napi_ref funcRef = nullptr;
    napi_status refStatus = napi_create_reference(env_, value, 1, &funcRef);
    if (refStatus != napi_ok || !funcRef) {
      rill_napi_log(kLogTag, "napiToJsi: failed to create ref for sandbox function");
      return jsi::Value::undefined();
    }

    // Track ref for cleanup in dispose()
    sandboxFuncRefs_.push_back(funcRef);

    auto *self = this;
    return jsi::Value(rt, jsi::Function::createFromHostFunction(
        rt,
        jsi::PropNameID::forAscii(rt, "sandboxFn"),
        0,
        [self, funcRef](jsi::Runtime &hostRt, const jsi::Value & /*thisVal*/,
                         const jsi::Value *args, size_t count) -> jsi::Value {
          if (self->disposed_) {
            return jsi::Value::undefined();
          }

          std::lock_guard<std::recursive_mutex> lock(self->mutex_);
          EnvScope scope(self->env_);
          if (!scope.ok()) {
            rill_napi_log(kLogTag, "sandboxFn: failed to open EnvScope");
            return jsi::Value::undefined();
          }

          napi_value func;
          napi_get_reference_value(self->env_, funcRef, &func);
          if (!func) {
            rill_napi_log(kLogTag, "sandboxFn: ref returned null");
            return jsi::Value::undefined();
          }

          // Convert host JSI args → sandbox N-API values
          std::vector<napi_value> napiArgs;
          napiArgs.reserve(count);
          for (size_t i = 0; i < count; i++) {
            napiArgs.push_back(self->jsiToNapi(hostRt, args[i]));
          }

          napi_value global;
          napi_get_global(self->env_, &global);

          napi_value result;
          napi_status callStatus = napi_call_function(
              self->env_, global, func,
              napiArgs.size(), napiArgs.empty() ? nullptr : napiArgs.data(),
              &result);

          if (callStatus != napi_ok) {
            std::string errMsg = self->getExceptionMessage();
            rill_napi_log(kLogTag, "sandboxFn call failed: " + errMsg);
            return jsi::Value::undefined();
          }

          // Drain microtasks spawned by the sandbox function
          drainAllMicrotasks(self->env_);

          return self->napiToJsi(hostRt, result);
        }));
  }
  default:
    return jsi::Value::undefined();
  }
}

// ---- Wrap a host JSI function as a N-API callback ----

napi_value HermesSandboxNAPIContext::wrapHostFunction(jsi::Runtime &rt,
                                                      jsi::Function &&func) {
  std::string cbId = "cb_" + std::to_string(++callbackCounter_);
  callbacks_[cbId] = std::make_shared<jsi::Function>(std::move(func));

  // Allocate persistent data for the closure
  auto *data = new HostFnData{this, cbId};

  napi_value napiFunc;
  napi_create_function(
      env_, cbId.c_str(), cbId.size(),
      [](napi_env env, napi_callback_info info) -> napi_value {
        void *rawData = nullptr;
        size_t argc = 16;
        napi_value argv[16];
        napi_get_cb_info(env, info, &argc, argv, nullptr, &rawData);

        auto *fnData = static_cast<HostFnData *>(rawData);
        if (!fnData || !fnData->self || fnData->self->disposed_) {
          napi_value undef;
          napi_get_undefined(env, &undef);
          return undef;
        }

        auto *self = fnData->self;
        auto it = self->callbacks_.find(fnData->callbackId);
        if (it == self->callbacks_.end()) {
          napi_value undef;
          napi_get_undefined(env, &undef);
          return undef;
        }

        jsi::Runtime *hostRt = self->hostRuntime_;
        try {
          // Convert N-API args -> JSI
          std::vector<jsi::Value> hostArgs;
          for (size_t i = 0; i < argc; i++) {
            hostArgs.push_back(self->napiToJsi(*hostRt, argv[i]));
          }

          jsi::Value result;
          if (hostArgs.empty()) {
            result = it->second->call(*hostRt);
          } else {
            result = it->second->call(
                *hostRt,
                static_cast<const jsi::Value *>(hostArgs.data()),
                hostArgs.size());
          }

          return self->jsiToNapi(*hostRt, result);
        } catch (const std::exception &e) {
          rill_napi_log(kLogTag,
                        std::string("Host callback error: ") + e.what());
          napi_value undef;
          napi_get_undefined(env, &undef);
          return undef;
        }
      },
      data, &napiFunc);

  return napiFunc;
}

// ---- Console shim ----

void HermesSandboxNAPIContext::installConsole() {
  if (!env_)
    return;

  napi_value global;
  napi_get_global(env_, &global);

  napi_value console;
  napi_create_object(env_, &console);

  // console.log / console.warn / console.error
  auto makeLogFn = [this](const char *prefix) -> napi_value {
    // Store prefix in a small heap allocation
    std::string *pfx = new std::string(prefix);
    napi_value fn;
    napi_create_function(
        env_, prefix, NAPI_AUTO_LENGTH,
        [](napi_env env, napi_callback_info info) -> napi_value {
          void *rawData = nullptr;
          size_t argc = 16;
          napi_value argv[16];
          napi_get_cb_info(env, info, &argc, argv, nullptr, &rawData);

          std::string *pfx = static_cast<std::string *>(rawData);
          std::string msg;
          if (pfx && !pfx->empty()) {
            msg = "[" + *pfx + "] ";
          }

          for (size_t i = 0; i < argc; i++) {
            if (i > 0)
              msg += " ";
            napi_valuetype t;
            napi_typeof(env, argv[i], &t);
            if (t == napi_string) {
              msg += napiStringToUtf8(env, argv[i]);
            } else if (t == napi_number) {
              double d;
              napi_get_value_double(env, argv[i], &d);
              if (d == static_cast<int64_t>(d))
                msg += std::to_string(static_cast<int64_t>(d));
              else
                msg += std::to_string(d);
            } else if (t == napi_boolean) {
              bool b;
              napi_get_value_bool(env, argv[i], &b);
              msg += b ? "true" : "false";
            } else if (t == napi_null) {
              msg += "null";
            } else if (t == napi_undefined) {
              msg += "undefined";
            } else {
              msg += "[object]";
            }
          }
          rill_napi_log(kLogTag, msg);

          napi_value undef;
          napi_get_undefined(env, &undef);
          return undef;
        },
        pfx, &fn);
    return fn;
  };

  napi_set_named_property(env_, console, "log", makeLogFn(""));
  napi_set_named_property(env_, console, "warn", makeLogFn("WARN"));
  napi_set_named_property(env_, console, "error", makeLogFn("ERROR"));

  napi_set_named_property(env_, global, "console", console);
}

// ---- HostObject interface ----

jsi::Value HermesSandboxNAPIContext::get(jsi::Runtime &rt,
                                         const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "eval") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 1 || !args[0].isString())
            throw jsi::JSError(rt, "eval requires a string argument");
          return this->eval(rt, args[0].asString(rt).utf8(rt));
        });
  }

  if (propName == "evalBytecode") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 1 || !args[0].isObject()) {
            throw jsi::JSError(rt, "evalBytecode requires an ArrayBuffer argument");
          }
          jsi::Object obj = args[0].asObject(rt);
          if (!obj.isArrayBuffer(rt)) {
            throw jsi::JSError(rt, "evalBytecode requires an ArrayBuffer argument");
          }

          std::string sourceUrl = "<sandbox-bytecode>";
          if (count > 1 && args[1].isString()) {
            sourceUrl = args[1].asString(rt).utf8(rt);
          }

          jsi::ArrayBuffer ab = obj.getArrayBuffer(rt);
          return this->evalBytecode(rt, ab.data(rt), ab.size(rt), sourceUrl);
        });
  }

  if (propName == "evalBytecodeAsset") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 1 || !args[0].isString()) {
            throw jsi::JSError(rt, "evalBytecodeAsset requires a string path argument");
          }
          return this->evalBytecodeAsset(rt, args[0].asString(rt).utf8(rt));
        });
  }

  if (propName == "inject") {
    return jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 2 || !args[0].isString())
            throw jsi::JSError(rt, "inject requires (name, value)");
          this->inject(rt, args[0].asString(rt).utf8(rt), args[1]);
          return jsi::Value::undefined();
        });
  }

  if (propName == "extract") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
               size_t count) -> jsi::Value {
          if (count < 1 || !args[0].isString())
            throw jsi::JSError(rt, "extract requires a string argument");
          return this->extract(rt, args[0].asString(rt).utf8(rt));
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

  return jsi::Value::undefined();
}

void HermesSandboxNAPIContext::set(jsi::Runtime &, const jsi::PropNameID &,
                                   const jsi::Value &) {}

std::vector<jsi::PropNameID>
HermesSandboxNAPIContext::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "eval"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "evalBytecode"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "evalBytecodeAsset"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "inject"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "extract"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  return props;
}

// ---- Core operations ----

jsi::Value HermesSandboxNAPIContext::eval(jsi::Runtime &rt,
                                          const std::string &code) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    throw jsi::JSError(rt, "Context has been disposed");

  EnvScope scope(env_);
  if (!scope.ok())
    throw jsi::JSError(rt, "Failed to open env scope for eval");

  napi_value source;
  napi_create_string_utf8(env_, code.c_str(), code.size(), &source);

  napi_value result;
  napi_status s = jsr_run_script(env_, source, "<sandbox>", &result);

  if (s != napi_ok) {
    std::string msg = getExceptionMessage();
    rill_napi_log(kLogTag, "eval failed: " + msg);
    throw jsi::JSError(rt, "[HermesSandboxNAPI] " + msg);
  }

  drainAllMicrotasks(env_);

  return napiToJsi(rt, result);
  // ~EnvScope closes the scope here - TLS restored before returning to host
}

jsi::Value HermesSandboxNAPIContext::evalBytecode(
    jsi::Runtime &rt,
    const uint8_t *bytecode,
    size_t size,
    const std::string &sourceUrl) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }
  if (bytecode == nullptr || size == 0) {
    throw jsi::JSError(rt, "evalBytecode: invalid bytecode (null or empty)");
  }

  EnvScope scope(env_);
  if (!scope.ok()) {
    throw jsi::JSError(rt, "Failed to open env scope for evalBytecode");
  }

  jsr_prepared_script prepared = nullptr;
  napi_status s = jsr_create_prepared_script(
      env_,
      bytecode,
      size,
      nullptr,
      nullptr,
      sourceUrl.c_str(),
      &prepared);

  if (s != napi_ok || !prepared) {
    std::string msg = getExceptionMessage();
    throw jsi::JSError(rt, "[HermesSandboxNAPI] evalBytecode prepare failed: " + msg);
  }

  napi_value result = nullptr;
  s = jsr_prepared_script_run(env_, prepared, &result);
  jsr_delete_prepared_script(env_, prepared);

  if (s != napi_ok) {
    std::string msg = getExceptionMessage();
    throw jsi::JSError(rt, "[HermesSandboxNAPI] evalBytecode run failed: " + msg);
  }

  drainAllMicrotasks(env_);

  return napiToJsi(rt, result);
}

jsi::Value HermesSandboxNAPIContext::evalBytecodeAsset(
    jsi::Runtime &rt,
    const std::string &assetPath) {
  std::string resolved = resolveAssetPath(assetPath);
  std::vector<uint8_t> bytecode;
  if (!readBinaryFile(resolved, bytecode)) {
    throw jsi::JSError(rt, "[HermesSandboxNAPI] evalBytecodeAsset failed to read file: " + resolved);
  }

  return evalBytecode(rt, bytecode.data(), bytecode.size(), resolved);
}

void HermesSandboxNAPIContext::inject(jsi::Runtime &rt, const std::string &name,
                                      const jsi::Value &value) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    throw jsi::JSError(rt, "Context has been disposed");

  EnvScope scope(env_);
  if (!scope.ok())
    throw jsi::JSError(rt, "Failed to open env scope for inject");

  napi_value global;
  napi_get_global(env_, &global);

  napi_value napiVal = jsiToNapi(rt, value);
  napi_set_named_property(env_, global, name.c_str(), napiVal);
}

jsi::Value HermesSandboxNAPIContext::extract(jsi::Runtime &rt,
                                             const std::string &name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    throw jsi::JSError(rt, "Context has been disposed");

  EnvScope scope(env_);
  if (!scope.ok())
    throw jsi::JSError(rt, "Failed to open env scope for extract");

  napi_value global;
  napi_get_global(env_, &global);

  napi_value val;
  napi_get_named_property(env_, global, name.c_str(), &val);
  return napiToJsi(rt, val);
}

// ============================================================================
// HermesSandboxNAPIRuntime
// ============================================================================

HermesSandboxNAPIRuntime::HermesSandboxNAPIRuntime(jsi::Runtime &hostRuntime,
                                                   double timeout)
    : hostRuntime_(&hostRuntime), timeout_(timeout), disposed_(false) {}

HermesSandboxNAPIRuntime::~HermesSandboxNAPIRuntime() { dispose(); }

void HermesSandboxNAPIRuntime::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  for (auto &ctx : contexts_)
    ctx->dispose();
  contexts_.clear();
}

jsi::Value HermesSandboxNAPIRuntime::get(jsi::Runtime &rt,
                                         const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createContext") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *,
               size_t) -> jsi::Value {
          return this->createContext(rt);
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

  return jsi::Value::undefined();
}

void HermesSandboxNAPIRuntime::set(jsi::Runtime &, const jsi::PropNameID &,
                                   const jsi::Value &) {}

std::vector<jsi::PropNameID>
HermesSandboxNAPIRuntime::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createContext"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  return props;
}

jsi::Value HermesSandboxNAPIRuntime::createContext(jsi::Runtime &rt) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    throw jsi::JSError(rt, "Runtime has been disposed");

  auto ctx =
      std::make_shared<HermesSandboxNAPIContext>(*hostRuntime_, timeout_);
  contexts_.push_back(ctx);
  return jsi::Object::createFromHostObject(rt, ctx);
}

// ============================================================================
// HermesSandboxNAPIModule
// ============================================================================

HermesSandboxNAPIModule::HermesSandboxNAPIModule(jsi::Runtime &) {}
HermesSandboxNAPIModule::~HermesSandboxNAPIModule() {}

jsi::Value HermesSandboxNAPIModule::get(jsi::Runtime &rt,
                                        const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createRuntime") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
           size_t count) -> jsi::Value {
          double timeout = 30000;
          if (count > 0 && args[0].isObject()) {
            jsi::Object opts = args[0].asObject(rt);
            if (opts.hasProperty(rt, "timeout")) {
              jsi::Value tv = opts.getProperty(rt, "timeout");
              if (tv.isNumber())
                timeout = tv.getNumber();
            }
          }
          auto runtime =
              std::make_shared<HermesSandboxNAPIRuntime>(rt, timeout);
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

void HermesSandboxNAPIModule::set(jsi::Runtime &, const jsi::PropNameID &,
                                  const jsi::Value &) {}

std::vector<jsi::PropNameID>
HermesSandboxNAPIModule::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createRuntime"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "isAvailable"));
  return props;
}

void HermesSandboxNAPIModule::install(jsi::Runtime &runtime) {
  auto module = std::make_shared<HermesSandboxNAPIModule>(runtime);
  jsi::Object moduleObj = jsi::Object::createFromHostObject(runtime, module);
  runtime.global().setProperty(runtime, "__HermesSandboxJSI",
                               std::move(moduleObj));
  rill_napi_log(kLogTag, "Installed __HermesSandboxJSI (N-API backend)");
}

} // namespace hermes_sandbox_napi
