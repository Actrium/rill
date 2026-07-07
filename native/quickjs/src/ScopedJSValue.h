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

#include "QuickJSPointerValue.h"
#include "QuickJSRuntime.h"

namespace qjs {

class ScopedJSValue {
public:
  explicit ScopedJSValue(JSContext *context, JSValue *value)
      : context_(context), value_(value) {
    assert(value_ != nullptr);
  };

  ~ScopedJSValue() {
    assert(value_ != nullptr);
    JS_FreeValue(context_, *value_);
  }

  // Prevent copying of Scope objects.
  ScopedJSValue(const ScopedJSValue &) = delete;
  ScopedJSValue &operator=(const ScopedJSValue &) = delete;

  JSValue get() const { return *value_; };

private:
  JSContext *context_;
  JSValue *value_;
};

class ScopedCString {
public:
  explicit ScopedCString(JSContext *context, const char *cstring)
      : context_(context), cstring_(cstring) {
    assert(cstring_ != nullptr);
  };

  ~ScopedCString() {
    assert(cstring_ != nullptr);
    JS_FreeCString(context_, cstring_);
  }

  // Prevent copying of Scope objects.
  ScopedCString(const ScopedCString &) = delete;
  ScopedCString &operator=(const ScopedCString &) = delete;

  const char *get() const { return cstring_; };

private:
  JSContext *context_;
  const char *cstring_;
};

} // namespace qjs
