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

class JSIValueConverter {
private:
  JSIValueConverter() = delete;
  ~JSIValueConverter() = delete;
  JSIValueConverter(JSIValueConverter &&) = delete;

public:
  static jsi::Value ToJSIValue(const QuickJSRuntime &runtime,
                               const JSValueConst &value);

  static JSValue ToJSValue(const QuickJSRuntime &runtime,
                           const jsi::Value &value);

  static JSValue ToJSString(const QuickJSRuntime &runtime,
                            const jsi::String &string);

  static JSValue ToJSString(const QuickJSRuntime &runtime,
                            const jsi::PropNameID &propName);

  static JSValue ToJSSymbol(const QuickJSRuntime &runtime,
                            const jsi::Symbol &symbol);

  static JSValue ToJSObject(const QuickJSRuntime &runtime,
                            const jsi::Object &object);

  static JSValue ToJSBigInt(const QuickJSRuntime &runtime,
                            const jsi::BigInt &bigInt);

  static JSValue ToJSArray(const QuickJSRuntime &runtime,
                           const jsi::Array &array);

  static JSValue ToJSFunction(const QuickJSRuntime &runtime,
                              const jsi::Function &function);

  static jsi::PropNameID ToJSIPropNameID(const QuickJSRuntime &runtime,
                                         const JSAtom &property);

  static std::string ToSTLString(JSContext *ctx, JSAtom atom);

  static std::string ToSTLString(JSContext *context, JSValueConst &string);
};

} // namespace qjs
