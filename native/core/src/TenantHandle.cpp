#include "TenantHandle.h"
#include "SandboxEngineConfig.h"

// Forward-declare engine-specific sandbox types.
// These headers are NOT included here to avoid type conflicts
// (e.g., QuickJS JSValue vs ObjC JSValue).
// We interact with them through the jsi::HostObject interface.

namespace rill::tenant_manager {

TenantHandle::TenantHandle(TenantId id, std::unique_ptr<TenantContext> context)
    : id_(id), context_(std::move(context)) {
  context_->state = TenantState::Created;
}

TenantHandle::~TenantHandle() {
  dispose();
}

void TenantHandle::createSandbox(facebook::jsi::Runtime& hostRuntime,
                                 double timeout) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_) return;

  // Access the engine-specific global module object.
  // These are installed by installSandboxBindings() before TenantManager.
#if RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_QUICKJS
  static constexpr const char* kModuleGlobal = "__QuickJSSandboxJSI";
#elif RILL_SANDBOX_ENGINE == RILL_SANDBOX_ENGINE_HERMES
  static constexpr const char* kModuleGlobal = "__HermesSandboxJSI";
#else
  static constexpr const char* kModuleGlobal = "__JSCSandboxJSI";
#endif

  auto global = hostRuntime.global();
  if (!global.hasProperty(hostRuntime, kModuleGlobal)) {
    throw std::runtime_error(
        std::string("[TenantHandle] Sandbox module not installed: ") +
        kModuleGlobal);
  }

  auto module = global.getPropertyAsObject(hostRuntime, kModuleGlobal);

  // Create a runtime via module.createRuntime({ timeout })
  auto createRuntimeFn =
      module.getPropertyAsFunction(hostRuntime, "createRuntime");

  facebook::jsi::Value runtimeVal;
  if (timeout > 0) {
    auto opts = facebook::jsi::Object(hostRuntime);
    opts.setProperty(hostRuntime, "timeout", timeout);
    runtimeVal = createRuntimeFn.call(hostRuntime, opts);
  } else {
    runtimeVal = createRuntimeFn.call(hostRuntime);
  }

  if (!runtimeVal.isObject()) {
    throw std::runtime_error("[TenantHandle] createRuntime did not return an object");
  }
  auto runtimeObj = runtimeVal.asObject(hostRuntime);

  // Store the runtime HostObject
  sandboxRuntime_ = runtimeObj.getHostObject(hostRuntime);

  // Create a context via runtime.createContext()
  auto createContextFn =
      runtimeObj.getPropertyAsFunction(hostRuntime, "createContext");
  auto contextVal = createContextFn.call(hostRuntime);

  if (!contextVal.isObject()) {
    throw std::runtime_error("[TenantHandle] createContext did not return an object");
  }
  auto contextObj = contextVal.asObject(hostRuntime);
  sandboxContext_ = contextObj.getHostObject(hostRuntime);

  context_->state = TenantState::Running;
}

facebook::jsi::Value TenantHandle::eval(facebook::jsi::Runtime& hostRuntime,
                                        const std::string& code) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_ || !sandboxContext_) {
    throw std::runtime_error("[TenantHandle] Cannot eval: sandbox not available");
  }

  context_->state = TenantState::Running;

  // Call eval through the HostObject `get` interface.
  // The sandbox context exposes "eval" as a property that returns a function.
  auto evalProp = sandboxContext_->get(
      hostRuntime, facebook::jsi::PropNameID::forUtf8(hostRuntime, "eval"));

  if (!evalProp.isObject() ||
      !evalProp.asObject(hostRuntime).isFunction(hostRuntime)) {
    throw std::runtime_error("[TenantHandle] Sandbox context has no eval function");
  }

  auto evalFn = evalProp.asObject(hostRuntime).asFunction(hostRuntime);
  return evalFn.call(hostRuntime,
                     facebook::jsi::String::createFromUtf8(hostRuntime, code));
}

void TenantHandle::inject(facebook::jsi::Runtime& hostRuntime,
                             const std::string& name,
                             const facebook::jsi::Value& value) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_ || !sandboxContext_) return;

  auto injectProp = sandboxContext_->get(
      hostRuntime,
      facebook::jsi::PropNameID::forUtf8(hostRuntime, "inject"));

  if (injectProp.isObject() &&
      injectProp.asObject(hostRuntime).isFunction(hostRuntime)) {
    auto fn = injectProp.asObject(hostRuntime).asFunction(hostRuntime);
    fn.call(hostRuntime,
            facebook::jsi::String::createFromUtf8(hostRuntime, name),
            value);
  }
}

facebook::jsi::Value TenantHandle::extract(
    facebook::jsi::Runtime& hostRuntime,
    const std::string& name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_ || !sandboxContext_) {
    return facebook::jsi::Value::undefined();
  }

  auto extractProp = sandboxContext_->get(
      hostRuntime,
      facebook::jsi::PropNameID::forUtf8(hostRuntime, "extract"));

  if (extractProp.isObject() &&
      extractProp.asObject(hostRuntime).isFunction(hostRuntime)) {
    auto fn = extractProp.asObject(hostRuntime).asFunction(hostRuntime);
    return fn.call(hostRuntime,
                   facebook::jsi::String::createFromUtf8(hostRuntime, name));
  }
  return facebook::jsi::Value::undefined();
}

void TenantHandle::dispose() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (disposed_) return;
  disposed_ = true;

  context_->state = TenantState::Destroying;

  // Release sandbox context first, then runtime.
  // The HostObject shared_ptrs will invoke the engine-specific dispose.
  sandboxContext_.reset();
  sandboxRuntime_.reset();

  context_->state = TenantState::Destroyed;
}

bool TenantHandle::isDisposed() const {
  return disposed_;
}

} // namespace rill::tenant_manager
