// -----------------------------------------------------------------------------
// TEST-ONLY JSI HOST - excluded from the shipped pod (see RillSandboxNative.podspec
// exclude_files). This file is part of a full jsi::Runtime over QuickJS. It is NOT
// the sandbox product: production hosts install the *SandboxJSI HostObject into
// their OWN runtime and never link this cluster (verified: no rill downstream links
// it). It is retained solely as a self-contained, dependency-free JSI host that lets
// the sandbox be unit- and leak-tested natively via native/quickjs/Makefile
// (QuickJS builds with vendored sources on plain Linux - no RN/JSC/Hermes needed).
// Do NOT add production code that depends on this file; if you do, it must be moved
// back into the shipped source set deliberately.
// -----------------------------------------------------------------------------
#include "HostProxy.h"

#include <memory>

#include "JSIValueConverter.h"

namespace qjs {

JSClassID HostObjectProxy::kJSClassID = 0;

JSClassDef HostObjectProxy::kJSClassDef = {
    .class_name = "HostObjectProxy",
    .finalizer = &HostObjectProxy::Finalizer,
};

void *OpaqueData::GetHostData(JSValueConst this_val) {
  auto opaqueData =
      reinterpret_cast<OpaqueData *>(JS_GetOpaqueUnsafe(this_val));

  if (opaqueData) {
    return opaqueData->hostData_;
  }

  return nullptr;
}

const JSCFunctionListEntry HostObjectProxy::kTemplateInterceptor[] = {
    JS_CINTERCEPTOR_DEF("HostObjectProxyInterceptor", &HostObjectProxy::Getter,
                        &HostObjectProxy::Setter, nullptr, nullptr,
                        &HostObjectProxy::Enumerator),
};

HostObjectProxy::HostObjectProxy(QuickJSRuntime &runtime,
                                 std::shared_ptr<jsi::HostObject> hostObject)
    : runtime_(runtime), hostObject_(hostObject) {
  opaqueData_.hostData_ = this;
}

std::shared_ptr<jsi::HostObject> HostObjectProxy::GetHostObject() {
  return hostObject_;
}

OpaqueData *HostObjectProxy::GetOpaqueData() { return &opaqueData_; }

JSClassID HostObjectProxy::GetClassID() {
  if (!kJSClassID) {
    JS_NewClassID(&kJSClassID);
  }
  return kJSClassID;
}

JSValue HostObjectProxy::Getter(JSContext *ctx, JSValueConst this_val,
                                JSAtom name) {
  HostObjectProxy *hostObjectProxy =
      reinterpret_cast<HostObjectProxy *>(OpaqueData::GetHostData(this_val));

  assert(hostObjectProxy);

  QuickJSRuntime &runtime = hostObjectProxy->runtime_;
  jsi::PropNameID sym = JSIValueConverter::ToJSIPropNameID(runtime, name);
  JS_FreeAtom(ctx, name);
  jsi::Value ret;
  try {
    ret = hostObjectProxy->hostObject_->get(runtime, sym);
  } catch (const jsi::JSError &error) {
    JS_Throw(ctx, JSIValueConverter::ToJSValue(runtime, error.value()));
    return JS_EXCEPTION;
  } catch (const std::exception &ex) {
    JS_ThrowInternalError(ctx, "%s", ex.what());
    return JS_EXCEPTION;
  } catch (...) {
    JS_ThrowInternalError(ctx, "Unknown error in HostObject getter");
    return JS_EXCEPTION;
  }
  return JSIValueConverter::ToJSValue(runtime, ret);
}

JSValue HostObjectProxy::Setter(JSContext *ctx, JSValueConst this_val,
                                JSAtom name, JSValue val) {
  HostObjectProxy *hostObjectProxy =
      reinterpret_cast<HostObjectProxy *>(OpaqueData::GetHostData(this_val));
  assert(hostObjectProxy);

  QuickJSRuntime &runtime = hostObjectProxy->runtime_;
  jsi::PropNameID sym = JSIValueConverter::ToJSIPropNameID(runtime, name);
  JS_FreeAtom(ctx, name);
  try {
    hostObjectProxy->hostObject_->set(
        runtime, sym, JSIValueConverter::ToJSIValue(runtime, val));
  } catch (const jsi::JSError &error) {
    JS_Throw(ctx, JSIValueConverter::ToJSValue(runtime, error.value()));
    return JS_EXCEPTION;
  } catch (const std::exception &ex) {
    JS_ThrowInternalError(ctx, "%s", ex.what());
    return JS_EXCEPTION;
  } catch (...) {
    JS_ThrowInternalError(ctx, "Unknown error in HostObject setter");
    return JS_EXCEPTION;
  }
  return JS_UNDEFINED;
}

JSValue HostObjectProxy::Enumerator(JSContext *ctx, JSValueConst this_val) {
  HostObjectProxy *hostObjectProxy =
      reinterpret_cast<HostObjectProxy *>(OpaqueData::GetHostData(this_val));
  assert(hostObjectProxy);

  QuickJSRuntime &runtime = hostObjectProxy->runtime_;
  auto names = hostObjectProxy->hostObject_->getPropertyNames(runtime);

  auto result = JS_NewArray(ctx);
  for (uint32_t i = 0; i < names.size(); ++i) {
    JSValue value = JSIValueConverter::ToJSString(runtime, names[i]);
    JS_SetPropertyInt64(ctx, result, i, value);
  }

  return result;
}

void HostObjectProxy::Finalizer(JSRuntime *, JSValue val) {
  auto hostObjectProxy =
      reinterpret_cast<HostObjectProxy *>(OpaqueData::GetHostData(val));
  assert(hostObjectProxy->hostObject_.use_count() == 1);
  hostObjectProxy->opaqueData_.nativeState_ = nullptr;
  delete hostObjectProxy;
}

JSClassID HostFunctionProxy::kJSClassID = 0;

JSClassDef HostFunctionProxy::kJSClassDef = {
    .class_name = "HostFunctionProxy",
    .finalizer = &HostFunctionProxy::Finalizer,
    .call = &HostFunctionProxy::FunctionCallback,
};

HostFunctionProxy::HostFunctionProxy(QuickJSRuntime &runtime,
                                     jsi::HostFunctionType &&hostFunction)
    : runtime_(runtime), hostFunction_(std::move(hostFunction)) {
  opaqueData_.hostData_ = this;
}

jsi::HostFunctionType &HostFunctionProxy::GetHostFunction() {
  return hostFunction_;
}

OpaqueData *HostFunctionProxy::GetOpaqueData() { return &opaqueData_; }

void HostFunctionProxy::Finalizer(JSRuntime *, JSValue val) {
  auto hostFunctionProxy =
      reinterpret_cast<HostFunctionProxy *>(OpaqueData::GetHostData(val));
  hostFunctionProxy->opaqueData_.nativeState_ = nullptr;
  delete hostFunctionProxy;
}

JSClassID HostFunctionProxy::GetClassID() {
  if (!kJSClassID) {
    JS_NewClassID(&kJSClassID);
  }
  return kJSClassID;
}

JSValue HostFunctionProxy::FunctionCallback(JSContext *ctx,
                                            JSValueConst func_obj,
                                            JSValueConst val, int argc,
                                            JSValueConst *argv, int) {
  auto *hostFunctionProxy =
      reinterpret_cast<HostFunctionProxy *>(OpaqueData::GetHostData(func_obj));

  auto &runtime = hostFunctionProxy->runtime_;

  const size_t maxStackArgCount = 8;
  jsi::Value stackArgs[maxStackArgCount];
  std::unique_ptr<jsi::Value[]> heapArgs;
  jsi::Value *args;
  size_t argCount = static_cast<size_t>(argc);
  if (argCount > maxStackArgCount) {
    heapArgs = std::make_unique<jsi::Value[]>(argCount);
    for (size_t i = 0; i < argCount; i++) {
      heapArgs[i] = JSIValueConverter::ToJSIValue(runtime, argv[i]);
    }
    args = heapArgs.get();
  } else {
    for (size_t i = 0; i < argCount; i++) {
      stackArgs[i] = JSIValueConverter::ToJSIValue(runtime, argv[i]);
    }
    args = stackArgs;
  }

  jsi::Value thisVal(JSIValueConverter::ToJSIValue(runtime, val));
  try {
    return JSIValueConverter::ToJSValue(
        runtime,
        hostFunctionProxy->hostFunction_(runtime, thisVal, args, argc));
  } catch (const jsi::JSError &error) {
    JS_Throw(ctx, JSIValueConverter::ToJSValue(runtime, error.value()));
    return JS_EXCEPTION;
  } catch (const std::exception &ex) {
    JS_ThrowInternalError(ctx, "%s", ex.what());
    return JS_EXCEPTION;
  } catch (...) {
    JS_ThrowInternalError(ctx, "Unknown error in HostFunction");
    return JS_EXCEPTION;
  }
}

} // namespace qjs
