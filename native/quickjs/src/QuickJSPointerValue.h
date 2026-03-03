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
