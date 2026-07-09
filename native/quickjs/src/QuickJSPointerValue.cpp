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
#include "QuickJSPointerValue.h"

namespace qjs {

QuickJSPointerValue::QuickJSPointerValue(JSRuntime *runtime, JSContext *context,
                                         JSValue value)
    : runtime_(runtime), value_(JS_DupValue(context, value)) {}

QuickJSPointerValue::~QuickJSPointerValue() {
  JS_FreeValueRT(runtime_, value_);
}

JSValue QuickJSPointerValue::Get(JSContext *context) const {
  return JS_DupValue(context, value_);
}

void QuickJSPointerValue::invalidate() noexcept { delete this; }

} // namespace qjs
