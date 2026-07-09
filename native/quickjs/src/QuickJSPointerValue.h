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

class QuickJSPointerValue final : public QuickJSRuntime::PointerValue {
public:
  QuickJSPointerValue(JSRuntime *runtime, JSContext *context, JSValue value);
  ~QuickJSPointerValue();

  JSValue Get(JSContext *context) const;

private:
  void invalidate() noexcept override;

private:
  friend class JSIValueConverter;
  friend class ScopedJSValue;
  friend class QuickJSRuntime;

  JSRuntime *runtime_;
  JSValue value_;
};

} // namespace qjs
