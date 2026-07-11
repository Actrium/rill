#include "HermesSandboxJSI.h"
#if __has_include(<hermes/hermes.h>)
#include <hermes/hermes.h>
#include <cmath>
#include <cstdint>
#else
#error "Rill Hermes sandbox requires Hermes headers. Enable Hermes in the host (hermes_enabled: true / USE_HERMES=1) or build with RILL_SANDBOX_ENGINE=jsc|quickjs."
#endif
#include <string>
#include <cstring>

// Cross-platform logging
#if defined(__APPLE__)
#include <os/log.h>
static void rill_log(const char *tag, const std::string &msg) {
  os_log_with_type(OS_LOG_DEFAULT, OS_LOG_TYPE_INFO, "[%{public}s] %{public}s", tag, msg.c_str());
}
#elif defined(__ANDROID__)
#include <android/log.h>
static void rill_log(const char *tag, const std::string &msg) {
  __android_log_print(ANDROID_LOG_INFO, tag, "%s", msg.c_str());
}
#else
#include <cstdio>
static void rill_log(const char *tag, const std::string &msg) {
  fprintf(stderr, "[%s] %s\n", tag, msg.c_str());
}
#endif

static const char *kLogTag = "HermesSandbox";

static const char *kTaskQueueShimScript = R"RILL_JS(
(function () {
  if (typeof globalThis.__rill_drainImmediateQueue === 'function') {
    return;
  }

  var queue = [];
  var cancelled = Object.create(null);
  var nextId = 1;

  function assertFunction(fn, name) {
    if (typeof fn !== 'function') {
      throw new TypeError(name + ' expects a function');
    }
  }

  if (typeof globalThis.setImmediate !== 'function') {
    globalThis.setImmediate = function (fn) {
      assertFunction(fn, 'setImmediate');
      var args = Array.prototype.slice.call(arguments, 1);
      var id = nextId++;
      queue.push({ id: id, fn: fn, args: args });
      return id;
    };
  }

  if (typeof globalThis.clearImmediate !== 'function') {
    globalThis.clearImmediate = function (id) {
      cancelled[id] = true;
    };
  }

  if (typeof globalThis.queueMicrotask !== 'function') {
    globalThis.queueMicrotask = function (fn) {
      assertFunction(fn, 'queueMicrotask');
      globalThis.setImmediate(fn);
    };
  }

  Object.defineProperty(globalThis, '__rill_drainImmediateQueue', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: function (limit) {
      var executed = 0;
      var max = typeof limit === 'number' && limit > 0 ? limit : 1000;
      while (queue.length > 0) {
        if (executed >= max) {
          return executed;
        }
        var task = queue.shift();
        if (cancelled[task.id]) {
          delete cancelled[task.id];
          continue;
        }
        executed++;
        task.fn.apply(undefined, task.args);
      }
      return executed;
    },
  });
})();
)RILL_JS";

namespace hermes_sandbox {

// MARK: - Value Conversion Helpers

// Guard against stack overflow from deeply nested or circular objects.
// A tenant returning a self-referencing object (a.self = a) must not be able
// to crash the host process via unbounded native recursion. Same limit and
// same convention as QuickJSSandboxJSI (kMaxDepth = 100, violation replaces
// the subtree with a descriptive string instead of throwing). True cycles are
// additionally caught early via an ancestor-path scan using
// jsi::Object::strictEquals (path length is bounded by kMaxDepth, so the
// O(depth) scan per object is cheap).
static constexpr int kMaxConversionDepth = 100;

// Returns true if `obj` is the same JS object as one of its ancestors on the
// current conversion path (i.e. a genuine circular reference).
static bool isCircular(jsi::Runtime &rt, const std::vector<jsi::Object> &path,
                       const jsi::Object &obj) {
  for (const auto &ancestor : path) {
    if (jsi::Object::strictEquals(rt, ancestor, obj)) {
      return true;
    }
  }
  return false;
}

namespace {
// Forward declarations: the definitions live in the anonymous namespace further
// down (next to sandboxToHostImpl, which also uses them), but hostToSandboxImpl
// below needs them for the host->sandbox binary passthrough.
jsi::Value makeArrayBufferIn(jsi::Runtime &dstRt, const uint8_t *data,
                             size_t size);
jsi::Value copyArrayBufferViewAcross(jsi::Runtime &srcRt, jsi::Runtime &dstRt,
                                     const jsi::Object &obj);
} // namespace

// Deep copy a JSI value from one runtime to another
// This is necessary because JSI values are tied to their runtime
jsi::Value HermesSandboxContext::hostToSandbox(jsi::Runtime &hostRt,
                                                jsi::Runtime &sandboxRt,
                                                const jsi::Value &value) {
  std::vector<jsi::Object> path;
  return hostToSandboxImpl(hostRt, sandboxRt, value, 0, path);
}

jsi::Value HermesSandboxContext::hostToSandboxImpl(jsi::Runtime &hostRt,
                                                    jsi::Runtime &sandboxRt,
                                                    const jsi::Value &value,
                                                    int depth,
                                                    std::vector<jsi::Object> &path) {
  if (value.isUndefined()) {
    return jsi::Value::undefined();
  }
  if (value.isNull()) {
    return jsi::Value::null();
  }
  if (value.isBool()) {
    return jsi::Value(value.getBool());
  }
  if (value.isNumber()) {
    return jsi::Value(value.getNumber());
  }
  if (value.isString()) {
    return jsi::String::createFromUtf8(sandboxRt,
                                       value.getString(hostRt).utf8(hostRt));
  }
  if (value.isSymbol()) {
    // Symbols cannot be transferred between runtimes
    return jsi::Value::undefined();
  }
  if (value.isObject()) {
    jsi::Object obj = value.getObject(hostRt);

    // Handle functions - wrap as a callback to host (no recursion, so no
    // depth/cycle checks needed)
    if (obj.isFunction(hostRt)) {
      return wrapHostFunctionForSandbox(hostRt, sandboxRt, obj.asFunction(hostRt));
    }

    // Binary passthrough (host -> sandbox) — the symmetric twin of
    // sandboxToHostImpl's binary branch. A host capability that returns an
    // ArrayBuffer / typed-array (e.g. a getBytes provider) must reach the guest
    // as real bytes; the generic property copy below sees zero own enumerable
    // props on an ArrayBuffer and would emit an empty object, silently
    // destroying the bytes. Bytes are COPIED into the sandbox realm.
    if (obj.isArrayBuffer(hostRt)) {
      jsi::ArrayBuffer src = obj.getArrayBuffer(hostRt);
      return makeArrayBufferIn(sandboxRt, src.data(hostRt), src.size(hostRt));
    }
    {
      jsi::Value sandboxBinary = copyArrayBufferViewAcross(hostRt, sandboxRt, obj);
      if (!sandboxBinary.isUndefined()) {
        return sandboxBinary;
      }
    }

    if (isCircular(hostRt, path, obj)) {
      return jsi::String::createFromUtf8(
          sandboxRt, "[hostToSandbox: circular reference dropped]");
    }
    if (depth > kMaxConversionDepth) {
      return jsi::String::createFromUtf8(
          sandboxRt, "[hostToSandbox: max depth exceeded]");
    }
    path.emplace_back(value.getObject(hostRt));

    // Handle arrays
    if (obj.isArray(hostRt)) {
      jsi::Array arr = obj.getArray(hostRt);
      size_t length = arr.size(hostRt);
      jsi::Array newArr = jsi::Array(sandboxRt, length);
      for (size_t i = 0; i < length; i++) {
        newArr.setValueAtIndex(
            sandboxRt, i,
            hostToSandboxImpl(hostRt, sandboxRt,
                              arr.getValueAtIndex(hostRt, i), depth + 1,
                              path));
      }
      path.pop_back();
      return newArr;
    }

    // Handle plain objects
    jsi::Object newObj = jsi::Object(sandboxRt);
    jsi::Array names = obj.getPropertyNames(hostRt);
    size_t length = names.size(hostRt);
    for (size_t i = 0; i < length; i++) {
      jsi::String name = names.getValueAtIndex(hostRt, i).getString(hostRt);
      std::string nameStr = name.utf8(hostRt);
      jsi::Value propValue = obj.getProperty(hostRt, name);
      newObj.setProperty(sandboxRt, nameStr.c_str(),
                         hostToSandboxImpl(hostRt, sandboxRt, propValue,
                                           depth + 1, path));
    }
    path.pop_back();
    return newObj;
  }

  return jsi::Value::undefined();
}

jsi::Value HermesSandboxContext::sandboxToHost(jsi::Runtime &sandboxRt,
                                                jsi::Runtime &hostRt,
                                                const jsi::Value &value) {
  std::vector<jsi::Object> path;
  return sandboxToHostImpl(sandboxRt, hostRt, value, 0, path);
}

namespace {

// Byte-owning jsi::MutableBuffer used to rebuild an ArrayBuffer in a
// DESTINATION realm from bytes copied out of a SOURCE realm. A copy is
// mandatory: the source value's backing store dies with its runtime's GC, and
// the two realms must never alias each other's memory.
class VectorBuffer : public jsi::MutableBuffer {
public:
  VectorBuffer(const uint8_t *data, size_t size) : bytes_(data, data + size) {}
  size_t size() const override { return bytes_.size(); }
  uint8_t *data() override { return bytes_.data(); }

private:
  std::vector<uint8_t> bytes_;
};

// Copy `size` bytes into a fresh ArrayBuffer owned by `dstRt`. Throws (loudly)
// if the destination runtime does not implement createArrayBuffer — never a
// silent empty object.
jsi::Value makeArrayBufferIn(jsi::Runtime &dstRt, const uint8_t *data,
                             size_t size) {
  return jsi::ArrayBuffer(dstRt, std::make_shared<VectorBuffer>(data, size));
}

// The ArrayBufferView constructor names eligible for same-kind
// reconstruction host-side. Also the detection allowlist: a plain object
// that merely LOOKS view-shaped ({buffer, byteOffset, byteLength}) but has a
// different constructor stays on the generic property-copy path.
bool isViewCtorName(const std::string &name) {
  static const char *kNames[] = {
      "Int8Array",         "Uint8Array",  "Uint8ClampedArray", "Int16Array",
      "Uint16Array",       "Int32Array",  "Uint32Array",       "Float32Array",
      "Float64Array",      "BigInt64Array", "BigUint64Array",  "DataView",
  };
  for (const char *candidate : kNames) {
    if (name == candidate) {
      return true;
    }
  }
  return false;
}

// Returns the `dstRt`-realm equivalent of a `srcRt` ArrayBufferView (typed
// array or DataView), or undefined when `obj` is not one. The view's byte
// WINDOW is copied into a dst ArrayBuffer, then best-effort re-wrapped in the
// same-named dst constructor (raw ArrayBuffer when unavailable). Direction-
// agnostic: drives BOTH sandbox->host and host->sandbox.
jsi::Value copyArrayBufferViewAcross(jsi::Runtime &srcRt, jsi::Runtime &dstRt,
                                     const jsi::Object &obj) {
  jsi::Value ctorVal = obj.getProperty(srcRt, "constructor");
  if (!ctorVal.isObject()) {
    return jsi::Value::undefined();
  }
  jsi::Value nameVal = ctorVal.getObject(srcRt).getProperty(srcRt, "name");
  if (!nameVal.isString()) {
    return jsi::Value::undefined();
  }
  std::string ctorName = nameVal.getString(srcRt).utf8(srcRt);
  if (!isViewCtorName(ctorName)) {
    return jsi::Value::undefined();
  }

  jsi::Value bufferVal = obj.getProperty(srcRt, "buffer");
  jsi::Value offsetVal = obj.getProperty(srcRt, "byteOffset");
  jsi::Value lengthVal = obj.getProperty(srcRt, "byteLength");
  if (!bufferVal.isObject() || !offsetVal.isNumber() ||
      !lengthVal.isNumber()) {
    return jsi::Value::undefined();
  }
  jsi::Object bufferObj = bufferVal.getObject(srcRt);
  if (!bufferObj.isArrayBuffer(srcRt)) {
    return jsi::Value::undefined();
  }

  // Validate as doubles BEFORE narrowing to size_t. A merely view-SHAPED plain
  // object (constructor.name in the allowlist, an ArrayBuffer `buffer`) can
  // carry byteOffset/byteLength of NaN, Infinity, negative, or non-integer;
  // casting those to size_t first is UB / implementation-defined, so a
  // post-cast range check cannot catch them.
  const double offsetD = offsetVal.getNumber();
  const double lengthD = lengthVal.getNumber();
  if (!std::isfinite(offsetD) || !std::isfinite(lengthD) || offsetD < 0 ||
      lengthD < 0 || offsetD != std::floor(offsetD) ||
      lengthD != std::floor(lengthD) ||
      offsetD > static_cast<double>(SIZE_MAX) ||
      lengthD > static_cast<double>(SIZE_MAX)) {
    return jsi::Value::undefined();
  }

  jsi::ArrayBuffer backing = bufferObj.getArrayBuffer(srcRt);
  const size_t backingSize = backing.size(srcRt);
  const auto offset = static_cast<size_t>(offsetD);
  const auto length = static_cast<size_t>(lengthD);
  if (offset > backingSize || length > backingSize - offset) {
    return jsi::Value::undefined();
  }

  jsi::Value dstBuffer =
      makeArrayBufferIn(dstRt, backing.data(srcRt) + offset, length);

  // Same-kind reconstruction, best-effort: a dst realm without the
  // constructor (or a throwing one) still gets the raw bytes.
  jsi::Object dstGlobal = dstRt.global();
  if (dstGlobal.hasProperty(dstRt, ctorName.c_str())) {
    jsi::Value dstCtor = dstGlobal.getProperty(dstRt, ctorName.c_str());
    if (dstCtor.isObject() && dstCtor.getObject(dstRt).isFunction(dstRt)) {
      try {
        return dstCtor.getObject(dstRt)
            .getFunction(dstRt)
            .callAsConstructor(dstRt, dstBuffer);
      } catch (...) {
        // fall through to the raw ArrayBuffer
      }
    }
  }
  return dstBuffer;
}

} // namespace

jsi::Value HermesSandboxContext::sandboxToHostImpl(jsi::Runtime &sandboxRt,
                                                    jsi::Runtime &hostRt,
                                                    const jsi::Value &value,
                                                    int depth,
                                                    std::vector<jsi::Object> &path) {
  if (value.isUndefined()) {
    return jsi::Value::undefined();
  }
  if (value.isNull()) {
    return jsi::Value::null();
  }
  if (value.isBool()) {
    return jsi::Value(value.getBool());
  }
  if (value.isNumber()) {
    return jsi::Value(value.getNumber());
  }
  if (value.isString()) {
    return jsi::String::createFromUtf8(hostRt,
                                       value.getString(sandboxRt).utf8(sandboxRt));
  }
  if (value.isSymbol()) {
    return jsi::Value::undefined();
  }
  if (value.isObject()) {
    jsi::Object obj = value.getObject(sandboxRt);

    if (obj.isFunction(sandboxRt)) {
      return wrapSandboxFunctionForHost(sandboxRt, hostRt, obj.asFunction(sandboxRt));
    }

    // Binary passthrough — MUST come before the generic property copy. An
    // ArrayBuffer has no own enumerable props, so the generic branch would
    // emit an empty host object and silently destroy the bytes (the binary
    // op-batch failure mode). Bytes are COPIED into the host realm; the two
    // realms never alias each other's memory.
    if (obj.isArrayBuffer(sandboxRt)) {
      jsi::ArrayBuffer src = obj.getArrayBuffer(sandboxRt);
      return makeArrayBufferIn(hostRt, src.data(sandboxRt), src.size(sandboxRt));
    }
    {
      // Typed-array view (Uint8Array & friends): JSI has no view API, so
      // probe the ArrayBufferView shape (an ArrayBuffer-valued `buffer` plus
      // numeric byteOffset/byteLength). Rebuild the view's byte WINDOW as a
      // host ArrayBuffer, then best-effort re-wrap it in the same-named host
      // view constructor.
      jsi::Value hostBinary = copyArrayBufferViewAcross(sandboxRt, hostRt, obj);
      if (!hostBinary.isUndefined()) {
        return hostBinary;
      }
    }

    // This direction crosses the trust boundary: the sandbox (tenant) is
    // untrusted, and a self-referencing return value must never overflow the
    // host's native stack.
    if (isCircular(sandboxRt, path, obj)) {
      return jsi::String::createFromUtf8(
          hostRt, "[sandboxToHost: circular reference dropped]");
    }
    if (depth > kMaxConversionDepth) {
      return jsi::String::createFromUtf8(
          hostRt, "[sandboxToHost: max depth exceeded]");
    }
    path.emplace_back(value.getObject(sandboxRt));

    if (obj.isArray(sandboxRt)) {
      jsi::Array arr = obj.getArray(sandboxRt);
      size_t length = arr.size(sandboxRt);
      jsi::Array newArr = jsi::Array(hostRt, length);
      for (size_t i = 0; i < length; i++) {
        newArr.setValueAtIndex(
            hostRt, i,
            sandboxToHostImpl(sandboxRt, hostRt,
                              arr.getValueAtIndex(sandboxRt, i), depth + 1,
                              path));
      }
      path.pop_back();
      return newArr;
    }

    jsi::Object newObj = jsi::Object(hostRt);
    jsi::Array names = obj.getPropertyNames(sandboxRt);
    size_t length = names.size(sandboxRt);
    for (size_t i = 0; i < length; i++) {
      jsi::String name = names.getValueAtIndex(sandboxRt, i).getString(sandboxRt);
      std::string nameStr = name.utf8(sandboxRt);
      jsi::Value propValue = obj.getProperty(sandboxRt, name);
      newObj.setProperty(hostRt, nameStr.c_str(),
                         sandboxToHostImpl(sandboxRt, hostRt, propValue,
                                           depth + 1, path));
    }
    path.pop_back();
    return newObj;
  }

  return jsi::Value::undefined();
}

// Wrap a host function for use in sandbox
// Creates a HostFunction in sandbox that proxies calls to the stored host function
// Implements identity caching: same host function always returns the same sandbox wrapper
jsi::Value HermesSandboxContext::wrapHostFunctionForSandbox(jsi::Runtime &hostRt,
                                                             jsi::Runtime &sandboxRt,
                                                             jsi::Function &&func) {
  jsi::Object funcObj = std::move(func); // Treat as object to access properties

  // 1. Try to retrieve existing Proxy ID from the function object (identity caching)
  std::string existingId;
  bool isCached = false;

  try {
    if (funcObj.hasProperty(hostRt, "__rill_proxy_id__")) {
      jsi::Value idVal = funcObj.getProperty(hostRt, "__rill_proxy_id__");
      if (idVal.isString()) {
        existingId = idVal.asString(hostRt).utf8(hostRt);
        std::string callbackId = "cb_" + existingId;

        // Check if this ID exists in our callback map
        auto it = callbacks_.find(callbackId);
        if (it != callbacks_.end()) {
          isCached = true;
          // Check if we have a cached wrapper
          auto wrapperIt = wrapperCache_.find(callbackId);
          if (wrapperIt != wrapperCache_.end()) {
            // Return reference to cached wrapper (creates new jsi::Value pointing to same function)
            return jsi::Value(sandboxRt, *wrapperIt->second);
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
      funcObj.setProperty(hostRt, "__rill_proxy_id__", jsi::String::createFromUtf8(hostRt, idStr));
    } catch (...) {
      // Failed to tag, continue anyway
    }
  }

  // Convert back to function and store
  jsi::Function funcToStore = funcObj.asFunction(hostRt);
  callbacks_[callbackId] = std::make_shared<jsi::Function>(std::move(funcToStore));

  // Capture what we need for the lambda
  std::string cbId = callbackId;
  auto *self = this;

  // Create a HostFunction in sandbox that calls the stored host function
  auto sandboxFunc = jsi::Function::createFromHostFunction(
      sandboxRt,
      jsi::PropNameID::forAscii(sandboxRt, cbId),
      0, // variadic
      [self, cbId](jsi::Runtime &rt, const jsi::Value &thisVal,
                   const jsi::Value *args, size_t count) -> jsi::Value {
        (void)thisVal;

        std::lock_guard<std::recursive_mutex> lock(self->mutex_);

        if (self->disposed_) {
          throw jsi::JSError(rt, "Context has been disposed");
        }

        // Use stored hostRuntime_ pointer
        jsi::Runtime *hostRt = self->hostRuntime_;
        if (!hostRt) {
          throw jsi::JSError(rt, "Host runtime is null");
        }

        auto it = self->callbacks_.find(cbId);
        if (it == self->callbacks_.end()) {
          rill_log(kLogTag, "Callback not found: " + cbId);
          return jsi::Value::undefined();
        }

        try {
          // Convert args from sandbox to host
          std::vector<jsi::Value> hostArgs;
          for (size_t i = 0; i < count; i++) {
            hostArgs.push_back(self->sandboxToHost(rt, *hostRt, args[i]));
          }

          // Call the host function
          jsi::Value result;
          if (hostArgs.empty()) {
            result = it->second->call(*hostRt);
          } else {
            // Use the (Runtime&, const Value*, size_t) overload
            result = it->second->call(
                *hostRt,
                static_cast<const jsi::Value*>(hostArgs.data()),
                hostArgs.size());
          }

          // Convert result from host to sandbox
          return self->hostToSandbox(*hostRt, rt, result);
        } catch (const jsi::JSError &e) {
          rill_log(kLogTag, std::string("Callback ") + cbId + " JSError: " + e.what());
          throw jsi::JSError(rt, e.what());
        } catch (const std::exception &e) {
          rill_log(kLogTag, std::string("Callback ") + cbId + " exception: " + e.what());
          return jsi::Value::undefined();
        }
      });

  // Cache the wrapper for identity preservation
  auto funcPtr = std::make_shared<jsi::Function>(std::move(sandboxFunc));
  wrapperCache_[callbackId] = funcPtr;

  return jsi::Value(sandboxRt, *funcPtr);
}

// Wrap a sandbox function for use in host
// Creates a HostFunction in host that proxies calls to the stored sandbox function
jsi::Value HermesSandboxContext::wrapSandboxFunctionForHost(jsi::Runtime & /*sandboxRt*/,
                                                             jsi::Runtime &hostRt,
                                                             jsi::Function &&func) {
  // Store the sandbox function with a unique ID
  std::string funcId = "sfn_" + std::to_string(++sandboxFunctionCounter_);
  sandboxFunctions_[funcId] = std::make_shared<jsi::Function>(std::move(func));

  // Capture what we need for the lambda
  std::string fId = funcId;
  auto *self = this;

  // Create a HostFunction in host that calls the stored sandbox function
  return jsi::Function::createFromHostFunction(
      hostRt,
      jsi::PropNameID::forAscii(hostRt, fId),
      0, // variadic
      [self, fId](jsi::Runtime &rt, const jsi::Value &thisVal,
                  const jsi::Value *args, size_t count) -> jsi::Value {
        (void)thisVal;

        std::lock_guard<std::recursive_mutex> lock(self->mutex_);

        if (self->disposed_) {
          throw jsi::JSError(rt, "Context has been disposed");
        }

        // Get the sandbox runtime
        jsi::Runtime *sandboxRt = self->sandboxRuntime_.get();
        if (!sandboxRt) {
          throw jsi::JSError(rt, "Sandbox runtime is null");
        }

        auto it = self->sandboxFunctions_.find(fId);
        if (it == self->sandboxFunctions_.end()) {
          rill_log(kLogTag, "Sandbox function not found: " + fId);
          return jsi::Value::undefined();
        }

        // Host->sandbox function calls execute tenant JS too: same budget
        // as eval (nested entries keep the outermost deadline).
        TimeLimitScope timeLimit(*self);
        try {
          // Convert args from host to sandbox
          std::vector<jsi::Value> sandboxArgs;
          for (size_t i = 0; i < count; i++) {
            sandboxArgs.push_back(self->hostToSandbox(rt, *sandboxRt, args[i]));
          }

          // Call the sandbox function
          jsi::Value result;
          if (sandboxArgs.empty()) {
            result = it->second->call(*sandboxRt);
          } else {
            result = it->second->call(
                *sandboxRt,
                static_cast<const jsi::Value*>(sandboxArgs.data()),
                sandboxArgs.size());
          }

          self->drainMicrotasks(rt);

          // Convert result from sandbox to host
          return self->sandboxToHost(*sandboxRt, rt, result);
        } catch (const jsi::JSError &e) {
          rill_log(kLogTag, std::string("Sandbox function ") + fId + " JSError: " + e.what());
          throw jsi::JSError(rt, e.what());
        } catch (const std::exception &e) {
          rill_log(kLogTag, std::string("Sandbox function ") + fId + " exception: " + e.what());
          return jsi::Value::undefined();
        }
      });
}

// MARK: - HermesSandboxContext Implementation

HermesSandboxContext::HermesSandboxContext(jsi::Runtime &hostRuntime,
                                           double timeout)
    : sandboxRuntime_(nullptr), hostRuntime_(&hostRuntime), disposed_(false),
      callbackCounter_(0), sandboxFunctionCounter_(0) {
  // ENFORCED via HermesRuntime::watchTimeLimit (see TimeLimitScope): each
  // top-level eval/evalBytecode gets a wall-clock budget; on expiry Hermes
  // injects an async break and the call throws instead of hanging the host
  // thread. timeout <= 0 means unlimited.
  timeoutMs_ = timeout;

  // Create an isolated Hermes runtime for the sandbox. Keep a typed pointer
  // for Hermes-specific APIs; ownership stays with sandboxRuntime_.
  auto hermesRt = facebook::hermes::makeHermesRuntime();
  hermesRuntime_ = hermesRt.get();
  sandboxRuntime_ = std::move(hermesRt);

  if (!sandboxRuntime_) {
    throw jsi::JSError(hostRuntime, "Failed to create Hermes sandbox runtime");
  }

  // Inject console shim into sandbox
  auto consoleObj = jsi::Object(*sandboxRuntime_);

  auto logFn = jsi::Function::createFromHostFunction(
      *sandboxRuntime_,
      jsi::PropNameID::forAscii(*sandboxRuntime_, "log"),
      1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
         size_t count) -> jsi::Value {
        std::string msg;
        for (size_t i = 0; i < count; i++) {
          if (i > 0) msg += " ";
          if (args[i].isString()) {
            msg += args[i].getString(rt).utf8(rt);
          } else if (args[i].isNumber()) {
            double num = args[i].getNumber();
            // Format without trailing zeros for integers
            if (num == static_cast<int64_t>(num)) {
              msg += std::to_string(static_cast<int64_t>(num));
            } else {
              msg += std::to_string(num);
            }
          } else if (args[i].isBool()) {
            msg += args[i].getBool() ? "true" : "false";
          } else if (args[i].isNull()) {
            msg += "null";
          } else if (args[i].isUndefined()) {
            msg += "undefined";
          } else {
            msg += "[object]";
          }
        }
        rill_log(kLogTag, msg);
        return jsi::Value::undefined();
      });

  consoleObj.setProperty(*sandboxRuntime_, "log", std::move(logFn));
  consoleObj.setProperty(*sandboxRuntime_, "warn",
      jsi::Function::createFromHostFunction(
          *sandboxRuntime_, jsi::PropNameID::forAscii(*sandboxRuntime_, "warn"), 1,
          [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
            if (count > 0 && args[0].isString()) {
              rill_log(kLogTag, "[WARN] " + args[0].getString(rt).utf8(rt));
            }
            return jsi::Value::undefined();
          }));
  consoleObj.setProperty(*sandboxRuntime_, "error",
      jsi::Function::createFromHostFunction(
          *sandboxRuntime_, jsi::PropNameID::forAscii(*sandboxRuntime_, "error"), 1,
          [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
            if (count > 0 && args[0].isString()) {
              rill_log(kLogTag, "[ERROR] " + args[0].getString(rt).utf8(rt));
            }
            return jsi::Value::undefined();
          }));

  sandboxRuntime_->global().setProperty(*sandboxRuntime_, "console",
                                        std::move(consoleObj));

  installTaskQueueShim(hostRuntime);

  rill_log(kLogTag, "Created new Hermes sandbox context");
}

HermesSandboxContext::~HermesSandboxContext() { dispose(); }

void HermesSandboxContext::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  // Clear wrapper cache before clearing callbacks
  wrapperCache_.clear();
  callbacks_.clear();
  sandboxFunctions_.clear();
  hermesRuntime_ = nullptr; // owned by sandboxRuntime_, about to be freed
  sandboxRuntime_.reset();
  rill_log(kLogTag, "Disposed sandbox context");
}

jsi::Value HermesSandboxContext::get(jsi::Runtime &rt,
                                     const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "eval") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)thisVal;
          if (count < 1 || !args[0].isString()) {
            throw jsi::JSError(rt, "eval requires a string argument");
          }
          std::string code = args[0].asString(rt).utf8(rt);
          return this->eval(rt, code);
        });
  }

  if (propName == "evalBytecode") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)thisVal;
          if (count < 1 || !args[0].isObject()) {
            throw jsi::JSError(rt, "evalBytecode requires an ArrayBuffer argument");
          }
          jsi::Object obj = args[0].asObject(rt);
          if (!obj.isArrayBuffer(rt)) {
            throw jsi::JSError(rt, "evalBytecode requires an ArrayBuffer argument");
          }
          jsi::ArrayBuffer ab = obj.getArrayBuffer(rt);
          return this->evalBytecode(rt, ab.data(rt), ab.size(rt));
        });
  }

  if (propName == "inject") {
    return jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)thisVal;
          if (count < 2 || !args[0].isString()) {
            throw jsi::JSError(rt, "inject requires (name: string, value: any)");
          }
          std::string globalName = args[0].asString(rt).utf8(rt);
          this->inject(rt, globalName, args[1]);
          return jsi::Value::undefined();
        });
  }

  if (propName == "extract") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)thisVal;
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
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)rt;
          (void)thisVal;
          (void)args;
          (void)count;
          this->dispose();
          return jsi::Value::undefined();
        });
  }

  return jsi::Value::undefined();
}

void HermesSandboxContext::set(jsi::Runtime &rt, const jsi::PropNameID &name,
                               const jsi::Value &value) {
  (void)rt;
  (void)name;
  (void)value;
  // Read-only
}

std::vector<jsi::PropNameID>
HermesSandboxContext::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "eval"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "evalBytecode"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "inject"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "extract"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  return props;
}

void HermesSandboxContext::installTaskQueueShim(jsi::Runtime &hostRt) {
  try {
    sandboxRuntime_->evaluateJavaScript(
        std::make_shared<jsi::StringBuffer>(kTaskQueueShimScript),
        "<rill-task-queue-shim>");
    drainMicrotasks(hostRt);
  } catch (const jsi::JSError &e) {
    throw jsi::JSError(hostRt,
                       std::string("[HermesSandbox] task queue shim: ") + e.what());
  } catch (const std::exception &e) {
    throw jsi::JSError(hostRt,
                       std::string("[HermesSandbox] task queue shim: ") + e.what());
  }
}

int HermesSandboxContext::drainImmediateQueue(jsi::Runtime &hostRt) {
  try {
    jsi::Value drainValue = sandboxRuntime_->global().getProperty(
        *sandboxRuntime_, "__rill_drainImmediateQueue");
    if (!drainValue.isObject()) {
      return 0;
    }
    jsi::Object drainObject = drainValue.asObject(*sandboxRuntime_);
    if (!drainObject.isFunction(*sandboxRuntime_)) {
      return 0;
    }
    jsi::Function drainFn = drainObject.asFunction(*sandboxRuntime_);
    jsi::Value countValue = drainFn.call(*sandboxRuntime_, 1000);
    return countValue.isNumber() ? static_cast<int>(countValue.getNumber()) : 0;
  } catch (const jsi::JSError &e) {
    throw jsi::JSError(hostRt,
                       std::string("[HermesSandbox] immediate queue: ") + e.what());
  } catch (const std::exception &e) {
    throw jsi::JSError(hostRt,
                       std::string("[HermesSandbox] immediate queue: ") + e.what());
  }
}

void HermesSandboxContext::drainMicrotasks(jsi::Runtime &hostRt) {
  constexpr int kMaxDrainPasses = 1000;

  for (int pass = 0; pass < kMaxDrainPasses; pass++) {
    bool nativeDrained = false;
    try {
      nativeDrained = sandboxRuntime_->drainMicrotasks(1000);
    } catch (const jsi::JSError &e) {
      throw jsi::JSError(hostRt,
                         std::string("[HermesSandbox] microtask drain: ") + e.what());
    } catch (const std::exception &e) {
      throw jsi::JSError(hostRt,
                         std::string("[HermesSandbox] microtask drain: ") + e.what());
    }

    int immediateCount = drainImmediateQueue(hostRt);
    if (nativeDrained && immediateCount == 0) {
      return;
    }
  }

  throw jsi::JSError(hostRt, "Hermes sandbox microtask drain exceeded safety limit");
}

// MARK: - TimeLimitScope

HermesSandboxContext::TimeLimitScope::TimeLimitScope(HermesSandboxContext &ctx)
    : ctx_(ctx) {
  // Guard the double->uint32 cast (Infinity / oversized budgets are UB to
  // cast — treat them as unlimited), and only arm at the outermost entry.
  if (ctx_.hermesRuntime_ && ctx_.timeoutMs_ > 0 &&
      ctx_.timeoutMs_ < 4294967295.0 && ctx_.timeLimitDepth_ == 0) {
    ctx_.hermesRuntime_->watchTimeLimit(
        static_cast<uint32_t>(ctx_.timeoutMs_));
    armedHere_ = true;
  }
  ctx_.timeLimitDepth_++;
}

HermesSandboxContext::TimeLimitScope::~TimeLimitScope() {
  ctx_.timeLimitDepth_--;
  if (armedHere_ && ctx_.hermesRuntime_) {
    ctx_.hermesRuntime_->unwatchTimeLimit();
  }
}

jsi::Value HermesSandboxContext::eval(jsi::Runtime &rt,
                                      const std::string &code) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  TimeLimitScope timeLimit(*this);
  try {
    jsi::Value result =
        sandboxRuntime_->evaluateJavaScript(
            std::make_shared<jsi::StringBuffer>(code), "<sandbox>");
    drainMicrotasks(rt);
    return sandboxToHost(*sandboxRuntime_, rt, result);
  } catch (const jsi::JSError &e) {
    throw jsi::JSError(rt, std::string("[HermesSandbox] ") + e.what());
  } catch (const std::exception &e) {
    throw jsi::JSError(rt, std::string("[HermesSandbox] ") + e.what());
  }
}

// Custom buffer adapter for bytecode
class BytecodeBuffer : public jsi::Buffer {
public:
  BytecodeBuffer(const uint8_t *data, size_t size)
      : data_(new uint8_t[size]), size_(size) {
    memcpy(data_, data, size);
  }

  ~BytecodeBuffer() override {
    delete[] data_;
  }

  size_t size() const override {
    return size_;
  }

  const uint8_t *data() const override {
    return data_;
  }

private:
  uint8_t *data_;
  size_t size_;
};

jsi::Value HermesSandboxContext::evalBytecode(jsi::Runtime &rt,
                                               const uint8_t *bytecode,
                                               size_t size) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  if (bytecode == nullptr || size == 0) {
    throw jsi::JSError(rt, "evalBytecode: invalid bytecode (null or empty)");
  }

  TimeLimitScope timeLimit(*this);
  try {
    auto prepared = sandboxRuntime_->prepareJavaScript(
        std::make_unique<BytecodeBuffer>(bytecode, size),
        "<precompiled>");

    jsi::Value result = sandboxRuntime_->evaluatePreparedJavaScript(prepared);
    drainMicrotasks(rt);
    return sandboxToHost(*sandboxRuntime_, rt, result);
  } catch (const jsi::JSError &e) {
    throw jsi::JSError(rt, std::string("[HermesSandbox] evalBytecode: ") + e.what());
  } catch (const std::exception &e) {
    throw jsi::JSError(rt, std::string("[HermesSandbox] evalBytecode: ") + e.what());
  }
}

void HermesSandboxContext::inject(jsi::Runtime &rt, const std::string &name,
                                     const jsi::Value &value) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  jsi::Value sandboxValue = hostToSandbox(rt, *sandboxRuntime_, value);
  sandboxRuntime_->global().setProperty(*sandboxRuntime_, name.c_str(),
                                        std::move(sandboxValue));
}

jsi::Value HermesSandboxContext::extract(jsi::Runtime &rt,
                                           const std::string &name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Context has been disposed");
  }

  jsi::Value sandboxValue =
      sandboxRuntime_->global().getProperty(*sandboxRuntime_, name.c_str());
  return sandboxToHost(*sandboxRuntime_, rt, sandboxValue);
}

// MARK: - HermesSandboxRuntime Implementation

HermesSandboxRuntime::HermesSandboxRuntime(jsi::Runtime &hostRuntime,
                                           double timeout)
    : hostRuntime_(&hostRuntime), timeout_(timeout), disposed_(false) {}

HermesSandboxRuntime::~HermesSandboxRuntime() { dispose(); }

void HermesSandboxRuntime::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_)
    return;
  disposed_ = true;

  for (auto &ctx : contexts_) {
    ctx->dispose();
  }
  contexts_.clear();
}

jsi::Value HermesSandboxRuntime::get(jsi::Runtime &rt,
                                     const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createContext") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)thisVal;
          (void)args;
          (void)count;
          return this->createContext(rt);
        });
  }

  if (propName == "dispose") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](jsi::Runtime &rt, const jsi::Value &thisVal,
               const jsi::Value *args, size_t count) -> jsi::Value {
          (void)rt;
          (void)thisVal;
          (void)args;
          (void)count;
          this->dispose();
          return jsi::Value::undefined();
        });
  }

  return jsi::Value::undefined();
}

void HermesSandboxRuntime::set(jsi::Runtime &rt, const jsi::PropNameID &name,
                               const jsi::Value &value) {
  (void)rt;
  (void)name;
  (void)value;
  // Read-only
}

std::vector<jsi::PropNameID>
HermesSandboxRuntime::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createContext"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "dispose"));
  return props;
}

jsi::Value HermesSandboxRuntime::createContext(jsi::Runtime &rt) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  if (disposed_) {
    throw jsi::JSError(rt, "Runtime has been disposed");
  }

  auto context = std::make_shared<HermesSandboxContext>(*hostRuntime_, timeout_);
  contexts_.push_back(context);

  return jsi::Object::createFromHostObject(rt, context);
}

// MARK: - HermesSandboxModule Implementation

HermesSandboxModule::HermesSandboxModule(jsi::Runtime &runtime) {
  (void)runtime;
}

HermesSandboxModule::~HermesSandboxModule() {}

jsi::Value HermesSandboxModule::get(jsi::Runtime &rt,
                                    const jsi::PropNameID &name) {
  std::string propName = name.utf8(rt);

  if (propName == "createRuntime") {
    return jsi::Function::createFromHostFunction(
        rt, name, 1,
        [](jsi::Runtime &rt, const jsi::Value &thisVal, const jsi::Value *args,
           size_t count) -> jsi::Value {
          (void)thisVal;
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

          auto runtime = std::make_shared<HermesSandboxRuntime>(rt, timeout);
          return jsi::Object::createFromHostObject(rt, runtime);
        });
  }

  if (propName == "isAvailable") {
    return jsi::Function::createFromHostFunction(
        rt, name, 0,
        [](jsi::Runtime &rt, const jsi::Value &thisVal, const jsi::Value *args,
           size_t count) -> jsi::Value {
          (void)rt;
          (void)thisVal;
          (void)args;
          (void)count;
          return jsi::Value(true);
        });
  }

  return jsi::Value::undefined();
}

void HermesSandboxModule::set(jsi::Runtime &rt, const jsi::PropNameID &name,
                              const jsi::Value &value) {
  (void)rt;
  (void)name;
  (void)value;
  // Read-only
}

std::vector<jsi::PropNameID>
HermesSandboxModule::getPropertyNames(jsi::Runtime &rt) {
  std::vector<jsi::PropNameID> props;
  props.push_back(jsi::PropNameID::forUtf8(rt, "createRuntime"));
  props.push_back(jsi::PropNameID::forUtf8(rt, "isAvailable"));
  return props;
}

void HermesSandboxModule::install(jsi::Runtime &runtime) {
  auto module = std::make_shared<HermesSandboxModule>(runtime);
  jsi::Object moduleObj = jsi::Object::createFromHostObject(runtime, module);
  runtime.global().setProperty(runtime, "__HermesSandboxJSI",
                               std::move(moduleObj));
  rill_log(kLogTag, "Installed __HermesSandboxJSI");
}

// Wrapper function for external linkage (avoids JSValue symbol conflicts)
void installHermesSandbox(jsi::Runtime &runtime) {
  HermesSandboxModule::install(runtime);
}

} // namespace hermes_sandbox
