/**
 * AdapterDebugTarget.h
 *
 * Wraps the method-level DebuggerAdapter/IEngineDebugger behind the raw-CDP
 * relay seam (IEngineDebugTarget), for engines with no built-in CDP agent
 * (QuickJS). It owns the Debugger domain: a raw CDP request is parsed into the
 * matching DebuggerAdapter handler call, and the returned CDPResponse is
 * serialized back to a raw CDP message through the outbound sink.
 *
 * Async events (Debugger.paused/resumed/scriptParsed/...) are NOT emitted here:
 * DebuggerAdapter already pushes them through CDPServer::sendEvent on its own
 * channel, which routes to the tenant's sessions independent of any request.
 */
#pragma once

#include "CDPServer.h"          // TenantId
#include "EngineDebugTarget.h"

#include <memory>
#include <mutex>
#include <unordered_map>

namespace rill::devtools {

class DebuggerAdapter;

class AdapterDebugTarget : public IEngineDebugTarget {
public:
  AdapterDebugTarget(std::shared_ptr<DebuggerAdapter> adapter, TenantId tenantId);

  DomainSet ownedDomains() const override;
  void onClientConnect(ConnectionId conn, CdpOutboundFn persistentSink) override;
  void onClientDisconnect(ConnectionId conn) override;
  void dispatch(ConnectionId conn, const RawCdpMessage& rawCdpRequest) override;

private:
  std::shared_ptr<DebuggerAdapter> adapter_;
  TenantId tenantId_;

  std::mutex sinksMutex_;
  std::unordered_map<ConnectionId, CdpOutboundFn> sinks_;
};

}  // namespace rill::devtools
