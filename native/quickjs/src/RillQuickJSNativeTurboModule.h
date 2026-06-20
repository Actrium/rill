#ifndef RILL_QUICKJS_NATIVE_TURBO_MODULE_H
#define RILL_QUICKJS_NATIVE_TURBO_MODULE_H

#include <jsi/jsi.h>

namespace jsi = facebook::jsi;

namespace rill::quickjs {

/**
 * TurboModule for QuickJS sandbox
 * Initializes QuickJS sandbox on app startup
 * Exposes global.__QuickJSSandboxJSI
 */
class RillQuickJSNativeTurboModule {
public:
  RillQuickJSNativeTurboModule();
  ~RillQuickJSNativeTurboModule();

  /**
   * Install JSI bindings into runtime
   */
  void initialize(jsi::Runtime &runtime);

private:
  bool initialized_;
};

} // namespace rill::quickjs

#endif // RILL_QUICKJS_NATIVE_TURBO_MODULE_H
