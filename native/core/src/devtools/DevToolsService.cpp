// WIP subsystem — gated behind RILL_WIP_CDP_DEVTOOLS (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in devtools/CDPServer.h.
// This TU drives CDPServer (itself gated); guard it so an ungated build is an empty TU.
#if RILL_WIP_CDP_DEVTOOLS

#include "DevToolsService.h"

#include "EngineDebugTarget.h"

namespace rill::devtools {

DevToolsService::DevToolsService(std::shared_ptr<CDPTransport> transport, uint16_t port) {
  CDPServerConfig config;
  config.enabled = true;
  config.host = "127.0.0.1";  // loopback only — never expose the CDP endpoint
  config.port = port;
  config.transport = std::move(transport);
  server_ = std::make_unique<CDPServer>(std::move(config));
}

bool DevToolsService::start() {
  return server_->start();
}

void DevToolsService::stop() {
  server_->stop();
}

bool DevToolsService::isRunning() const {
  return server_->isRunning();
}

void DevToolsService::onTenantCreated(TenantId id, const std::string& title) {
  server_->registerTenant(id, title);
}

void DevToolsService::onTenantDestroyed(TenantId id) {
  server_->unregisterTenant(id);
}

void DevToolsService::registerDebugTarget(TenantId id,
                                          std::shared_ptr<IEngineDebugTarget> target) {
  server_->registerDebugTarget(id, std::move(target));
}

}  // namespace rill::devtools

#endif  // RILL_WIP_CDP_DEVTOOLS
