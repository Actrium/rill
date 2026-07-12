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
#pragma once

#include <jsi/jsi.h>
#include "QuickJSRuntime.h"

namespace qjs {

struct OpaqueData {
  static void *GetHostData(JSValueConst this_val);

  void *hostData_;
  std::shared_ptr<facebook::jsi::NativeState> nativeState_;
};

class OpaqueOwner {
public:
  virtual ~OpaqueOwner() = default;
  virtual OpaqueData *GetOpaqueData() = 0;
};

class HostObjectProxy : public OpaqueOwner {
public:
  HostObjectProxy(QuickJSRuntime &runtime,
                  std::shared_ptr<jsi::HostObject> hostObject);

  std::shared_ptr<jsi::HostObject> GetHostObject();

  OpaqueData *GetOpaqueData() override;

  static JSClassID GetClassID();

  static JSValue Getter(JSContext *ctx, JSValueConst this_val, JSAtom name);

  static JSValue Setter(JSContext *ctx, JSValueConst this_val, JSAtom name,
                        JSValue val);

  static JSValue Enumerator(JSContext *ctx, JSValueConst this_val);

  static void Finalizer(JSRuntime *rt, JSValue val);

  static JSClassDef kJSClassDef;
  static const JSCFunctionListEntry kTemplateInterceptor[];

private:
  QuickJSRuntime &runtime_;
  std::shared_ptr<jsi::HostObject> hostObject_;
  OpaqueData opaqueData_;

  static JSClassID kJSClassID;
};

class HostFunctionProxy : public OpaqueOwner {
public:
  HostFunctionProxy(QuickJSRuntime &runtime,
                    jsi::HostFunctionType &&hostFunction);

  jsi::HostFunctionType &GetHostFunction();

  OpaqueData *GetOpaqueData() override;

  static JSClassID GetClassID();

  static void Finalizer(JSRuntime *rt, JSValue val);

  static JSValue FunctionCallback(JSContext *ctx, JSValueConst func_obj,
                                  JSValueConst val, int argc,
                                  JSValueConst *argv, int flags);

  static JSClassDef kJSClassDef;

private:
  QuickJSRuntime &runtime_;
  jsi::HostFunctionType hostFunction_;
  OpaqueData opaqueData_;

  static JSClassID kJSClassID;
};

} // namespace qjs
