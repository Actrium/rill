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
  std::shared_ptr<hcdp::CDPAgent> agent =
      hcdp::CDPAgent::create(execCtxId_, *debugAPI_, enqueue_,
                             std::move(persistentSink), hcdp::State{});
  std::lock_guard<std::mutex> lock(agentsMutex_);
  agents_[conn] = std::move(agent);
}

void CDPAgentTarget::dispatch(ConnectionId conn, const RawCdpMessage& raw) {
  // Take a strong reference under the lock, call outside it. A concurrent
  // onClientDisconnect() may erase the map entry while this command is in
  // flight; our reference keeps the agent alive, so the worst case is a
  // command handled for an already-detached client (its sink then targets a
  // connection the server no longer knows — sendToConnection drops it).
  std::shared_ptr<hcdp::CDPAgent> agent;
  {
    std::lock_guard<std::mutex> lock(agentsMutex_);
    auto it = agents_.find(conn);
    if (it != agents_.end()) agent = it->second;
  }
  // handleCommand is safe from any thread; the response and any events arrive
  // later on the runtime thread and go out through this connection's sink.
  if (agent) agent->handleCommand(raw);
  // If the client disconnected mid-command, dropping `agent` here runs
  // ~CDPAgent after the command completed — never mid-use.
}

void CDPAgentTarget::onClientDisconnect(ConnectionId conn) {
  std::shared_ptr<hcdp::CDPAgent> dead;
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
  // Drop our reference. ~CDPAgent runs here — or, if a dispatch() is mid-
  // handleCommand on another thread, when that call returns and releases the
  // last reference. Either way tasks enqueued during destruction still flow
  // via enqueue_.
  dead.reset();
}

}  // namespace rill::devtools

#endif  // RILL_WIP_CDP_DEVTOOLS && !NDEBUG
