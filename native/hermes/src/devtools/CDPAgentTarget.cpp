#include "CDPAgentTarget.h"

#if defined(RILL_WIP_CDP_DEVTOOLS) && !defined(NDEBUG)

#include <hermes/AsyncDebuggerAPI.h>

#include <string>
#include <utility>

namespace rill::devtools {

namespace hcdp = facebook::hermes::cdp;
namespace hdbg = facebook::hermes::debugger;

CDPAgentTarget::CDPAgentTarget(int32_t executionContextId,
                               std::shared_ptr<hcdp::CDPDebugAPI> debugAPI,
                               hdbg::EnqueueRuntimeTaskFunc enqueue)
    : execCtxId_(executionContextId),
      debugAPI_(std::move(debugAPI)),
      enqueue_(std::move(enqueue)) {}

CDPAgentTarget::~CDPAgentTarget() = default;

DomainSet CDPAgentTarget::ownedDomains() const {
  DomainSet d;
  d.runtime = true;
  d.debugger = true;
  d.profiler = true;  // CDPAgent owns Runtime+Debugger+Profiler; Log/HeapProfiler stay local (MVP)
  return d;
}

void CDPAgentTarget::onClientConnect(ConnectionId conn, CdpOutboundFn persistentSink) {
  // CdpOutboundFn and cdp::OutboundMessageFunc are both
  // std::function<void(const std::string&)> — pass the sink straight through.
  auto agent = hcdp::CDPAgent::create(execCtxId_, *debugAPI_, enqueue_,
                                      std::move(persistentSink), hcdp::State{});
  std::lock_guard<std::mutex> lock(agentsMutex_);
  agents_[conn] = std::move(agent);
}

void CDPAgentTarget::dispatch(ConnectionId conn, const RawCdpMessage& raw) {
  hcdp::CDPAgent* agent = nullptr;
  {
    std::lock_guard<std::mutex> lock(agentsMutex_);
    auto it = agents_.find(conn);
    if (it != agents_.end()) agent = it->second.get();
  }
  // handleCommand is safe from any thread; the response and any events arrive
  // later on the runtime thread and go out through this connection's sink.
  if (agent) agent->handleCommand(raw);
}

void CDPAgentTarget::onClientDisconnect(ConnectionId conn) {
  std::unique_ptr<hcdp::CDPAgent> dead;
  {
    std::lock_guard<std::mutex> lock(agentsMutex_);
    auto it = agents_.find(conn);
    if (it == agents_.end()) return;
    dead = std::move(it->second);
    agents_.erase(it);
  }
  // If this client left the runtime paused at a breakpoint, no one else will
  // resume it and the host thread stays frozen. Force a resume from the runtime
  // thread via a thread-safe interrupt before destroying the agent. Capture the
  // CDPDebugAPI by value (shared_ptr) so the closure can't dangle during
  // teardown. Guard with isWaitingForCommand() (NOT isPaused()): resumeFromPaused
  // is only valid when the next command is expected.
  auto keep = debugAPI_;
  keep->asyncDebuggerAPI().triggerInterrupt_TS(
      [keep](facebook::hermes::HermesRuntime&) {
        auto& dbg = keep->asyncDebuggerAPI();
        if (dbg.isWaitingForCommand()) {
          dbg.resumeFromPaused(hdbg::AsyncDebugCommand::Continue);
        }
      });
  dead.reset();  // ~CDPAgent: tasks it enqueues during destruction still flow via enqueue_
}

}  // namespace rill::devtools

#endif  // RILL_WIP_CDP_DEVTOOLS && !NDEBUG
