/**
 * DevToolsService.h
 *
 * Owns the CDPServer lifecycle and mirrors tenant create/destroy into CDP
 * target registration (Phase-2 T2.2, production wiring). The transport is
 * injected — CDPTransportApple in production, a mock in tests — so the wiring
 * logic is unit-testable without the Apple-only transport or the RN/JSI stack.
 *
 * RillTenantManager owns one of these behind RILL_WIP_CDP_DEVTOOLS and forwards
 * its tenant lifecycle to onTenantCreated/onTenantDestroyed.
 */
#pragma once

#include "CDPServer.h"

#include <memory>
#include <string>

namespace rill::devtools {

class IEngineDebugTarget;

class DevToolsService {
public:
  // `transport` is injected (CDPTransportApple in production). host/port default
  // to loopback:9229 — the CDP endpoint must never leave localhost.
  explicit DevToolsService(std::shared_ptr<CDPTransport> transport, uint16_t port = 9229);

  bool start();
  void stop();
  bool isRunning() const;

  // Mirror the tenant lifecycle into CDP target discovery.
  void onTenantCreated(TenantId id, const std::string& title);
  void onTenantDestroyed(TenantId id);

  // Attach a per-tenant debug target (AdapterDebugTarget today; CDPAgentTarget
  // for Hermes in Phase-3). Owned domains are then served by the target.
  void registerDebugTarget(TenantId id, std::shared_ptr<IEngineDebugTarget> target);

  // Escape hatch for wiring/tests.
  CDPServer& server() { return *server_; }

private:
  std::unique_ptr<CDPServer> server_;
};

}  // namespace rill::devtools
