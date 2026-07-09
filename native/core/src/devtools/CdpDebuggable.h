/**
 * CdpDebuggable.h
 *
 * Capability interface that lets the engine-agnostic tenant layer obtain an
 * engine-specific CDP debug target without knowing the concrete sandbox type.
 *
 * TenantHandle holds each sandbox as an opaque jsi::HostObject. A sandbox that
 * can be debugged over CDP (today: Hermes) also implements ICdpDebuggable;
 * TenantHandle recovers it with a dynamic_cast and RillTenantManager calls
 * createCdpDebugTarget() generically. All Hermes-specific wiring (CDPDebugAPI,
 * the runtime-task enqueue over the host CallInvoker, CDPAgentTarget) stays
 * inside native/hermes — this header pulls in neither Hermes nor ReactCommon
 * headers, only forward declarations.
 */
#pragma once

#include <cstdint>
#include <memory>

namespace facebook {
namespace react {
class CallInvoker;
}
}  // namespace facebook

namespace rill::devtools {

class IEngineDebugTarget;

class ICdpDebuggable {
public:
  virtual ~ICdpDebuggable() = default;

  // Build a per-tenant CDP debug target. `callInvoker` runs runtime tasks on the
  // host JS thread (the guest runtime's thread); `executionContextId` is the CDP
  // execution context id for this tenant. Returns null if debugging is
  // unavailable. The implementation owns all engine-specific details.
  virtual std::shared_ptr<IEngineDebugTarget> createCdpDebugTarget(
      std::shared_ptr<facebook::react::CallInvoker> callInvoker,
      std::int32_t executionContextId) = 0;
};

}  // namespace rill::devtools
