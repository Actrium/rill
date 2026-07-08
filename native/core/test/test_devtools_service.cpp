/**
 * test_devtools_service.cpp
 *
 * Unit tests for DevToolsService: CDPServer lifecycle + tenant mirroring +
 * debug-target registration, with an injected mock transport (Phase-2 T2.2).
 */
#include "test_framework.h"
#include "../src/devtools/DevToolsService.h"
#include "../src/devtools/EngineDebugTarget.h"

#include <memory>
#include <string>
#include <vector>

using namespace rill::devtools;
using namespace rill::test;

namespace {

struct MockTransport : public CDPTransport {
  bool started = false;
  std::vector<std::pair<ConnectionId, std::string>> sent;
  bool start(const std::string&, uint16_t) override { started = true; return true; }
  void stop() override {}
  void send(ConnectionId c, const std::string& m) override { sent.push_back({c, m}); }
  void close(ConnectionId) override {}
  void simulateConnect(ConnectionId c) { if (onConnect_) onConnect_(c); }
  void simulateMessage(ConnectionId c, const std::string& m) { if (onMessage_) onMessage_(c, m); }
};

// Records what it received; owns the Debugger domain.
struct RecordingTarget : public IEngineDebugTarget {
  std::vector<std::string> received;
  DomainSet ownedDomains() const override { DomainSet d; d.debugger = true; return d; }
  void dispatch(const RawCdpMessage& req, const CdpOutboundFn& out) override {
    received.push_back(req);
    out(std::string("{\"id\":1,\"result\":{}}"));
  }
};

TestSuite createDevToolsServiceTests() {
  TestSuite suite{"DevToolsService", {}};

  suite.cases.push_back({"start brings the CDP server up on the injected transport", []() {
    auto transport = std::make_shared<MockTransport>();
    DevToolsService svc(transport);
    assertTrue(svc.start(), "started");
    assertTrue(svc.isRunning(), "running");
    assertTrue(transport->started, "transport started");
    svc.stop();
    assertFalse(svc.isRunning(), "stopped");
  }});

  suite.cases.push_back({"tenant lifecycle mirrors into CDP target discovery", []() {
    auto transport = std::make_shared<MockTransport>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(1, "App A");
    svc.onTenantCreated(2, "App B");
    assertTrue(svc.server().hasTenant(1), "tenant 1 registered");
    assertTrue(svc.server().hasTenant(2), "tenant 2 registered");
    svc.onTenantDestroyed(1);
    assertFalse(svc.server().hasTenant(1), "tenant 1 gone");
    assertTrue(svc.server().hasTenant(2), "tenant 2 remains");
    svc.stop();
  }});

  suite.cases.push_back({"a registered debug target serves its owned domain end to end", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");        // tenant 0 (requests carry no sessionId)
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    assertEqual(target->received.size(), size_t(1), "target received the request");
    assertTrue(transport->sent.size() >= 1, "target response forwarded to the client");
    svc.stop();
  }});

  return suite;
}

}  // anonymous namespace

static struct DevToolsServiceRegistrar {
  DevToolsServiceRegistrar() {
    TestRunner::instance().addSuite(createDevToolsServiceTests());
  }
} s_devToolsServiceRegistrar;
