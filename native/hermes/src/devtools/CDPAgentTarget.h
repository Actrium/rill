/**
 * CDPAgentTarget.h
 *
 * Hermes passthrough behind the relay seam (IEngineDebugTarget). A CDP-native
 * engine speaks the protocol end-to-end, so this is a thin adapter:
 *   - one facebook::hermes::cdp::CDPDebugAPI per tenant (per HermesRuntime),
 *     created and owned by the sandbox; shared in here to keep it alive across
 *     the interrupt/teardown paths;
 *   - one facebook::hermes::cdp::CDPAgent per DevTools connection.
 *
 * We do NOT write a pause pump: Hermes' AsyncDebuggerAPI blocks the runtime
 * thread in processInterruptWhilePaused() and CDPAgent routes commands through
 * RuntimeTaskRunner (TaskQueues::All) so a resume reaches a paused runtime via
 * the interrupt path. Our only obligation is the integrator enqueue callback
 * (a thin callInvoker adapter, injected) and the per-connection outbound sink.
 *
 * Whole TU is dev-only + WIP-gated: it pulls in Hermes CDP headers.
 */
#pragma once

#if defined(RILL_WIP_CDP_DEVTOOLS) && !defined(NDEBUG)

#include "devtools/EngineDebugTarget.h"  // IEngineDebugTarget, ConnectionId, CdpOutboundFn

#include <hermes/RuntimeTaskRunner.h>    // debugger::EnqueueRuntimeTaskFunc
#include <hermes/cdp/CDPAgent.h>         // cdp::CDPAgent, cdp::State, cdp::OutboundMessageFunc
#include <hermes/cdp/CDPDebugAPI.h>      // cdp::CDPDebugAPI

#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace rill::devtools {

class CDPAgentTarget : public IEngineDebugTarget {
public:
  CDPAgentTarget(int32_t executionContextId,
                 std::shared_ptr<facebook::hermes::cdp::CDPDebugAPI> debugAPI,
                 facebook::hermes::debugger::EnqueueRuntimeTaskFunc enqueue);
  ~CDPAgentTarget() override;

  DomainSet ownedDomains() const override;
  void onClientConnect(ConnectionId conn, CdpOutboundFn persistentSink) override;
  void onClientDisconnect(ConnectionId conn) override;
  void dispatch(ConnectionId conn, const RawCdpMessage& raw) override;

private:
  const int32_t execCtxId_;
  // shared, not a bare reference: the interrupt closure fired at disconnect must
  // keep the CDPDebugAPI alive regardless of teardown ordering.
  std::shared_ptr<facebook::hermes::cdp::CDPDebugAPI> debugAPI_;
  facebook::hermes::debugger::EnqueueRuntimeTaskFunc enqueue_;

  std::mutex agentsMutex_;
  std::unordered_map<ConnectionId,
                     std::unique_ptr<facebook::hermes::cdp::CDPAgent>> agents_;
};

}  // namespace rill::devtools

#endif  // RILL_WIP_CDP_DEVTOOLS && !NDEBUG
