#include "RillQuickJSNativeTurboModule.h"
#include "QuickJSSandboxJSI.h"

namespace rill::quickjs {

RillQuickJSNativeTurboModule::RillQuickJSNativeTurboModule()
    : initialized_(false) {}

RillQuickJSNativeTurboModule::~RillQuickJSNativeTurboModule() {}

void RillQuickJSNativeTurboModule::initialize(jsi::Runtime &runtime) {
  if (initialized_) {
    return;
  }

  // Install QuickJS sandbox JSI bindings
  quickjs_sandbox::QuickJSSandboxModule::install(runtime);

  initialized_ = true;
}

} // namespace rill::quickjs
