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
#include <unordered_map>
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
  void simulateConnect(ConnectionId c, const std::string& path = "") { if (onConnect_) onConnect_(c, path); }
  void simulateMessage(ConnectionId c, const std::string& m) { if (onMessage_) onMessage_(c, m); }
  void simulateDisconnect(ConnectionId c) { if (onDisconnect_) onDisconnect_(c); }
  HttpResponse simulateHttpGet(const std::string& method, const std::string& path) {
    return onHttpGet_ ? onHttpGet_(method, path) : HttpResponse{404, "Not Found", "", ""};
  }
};

// Owns the Debugger domain but, unlike RecordingTarget, does NOT reply inside
// dispatch — it stashes the persistent sink and lets the test emit out of band
// (modelling a CDP agent whose responses/events arrive asynchronously). Also
// counts connect/disconnect so tests can assert the once-per-connection contract.
struct AsyncFakeTarget : public IEngineDebugTarget {
  std::unordered_map<ConnectionId, CdpOutboundFn> sinks;
  std::vector<std::pair<ConnectionId, std::string>> dispatched;
  int connectCount = 0;
  int disconnectCount = 0;
  DomainSet ownedDomains() const override { DomainSet d; d.debugger = true; return d; }
  void onClientConnect(ConnectionId c, CdpOutboundFn s) override { sinks[c] = std::move(s); ++connectCount; }
  void onClientDisconnect(ConnectionId c) override { sinks.erase(c); ++disconnectCount; }
  void dispatch(ConnectionId c, const RawCdpMessage& req) override { dispatched.push_back({c, req}); }
  // Out-of-band emit through the connection's persistent sink (no-op if gone).
  void emit(ConnectionId c, const std::string& msg) {
    auto it = sinks.find(c);
    if (it != sinks.end()) it->second(msg);
  }
};

// Records what it received; owns the Debugger domain. Emits via the persistent
// per-connection sink installed at onClientConnect.
struct RecordingTarget : public IEngineDebugTarget {
  std::vector<std::string> received;
  std::unordered_map<ConnectionId, CdpOutboundFn> sinks;
  DomainSet ownedDomains() const override { DomainSet d; d.debugger = true; return d; }
  void onClientConnect(ConnectionId c, CdpOutboundFn s) override { sinks[c] = std::move(s); }
  void onClientDisconnect(ConnectionId c) override { sinks.erase(c); }
  void dispatch(ConnectionId c, const RawCdpMessage& req) override {
    received.push_back(req);
    auto it = sinks.find(c);
    if (it != sinks.end()) it->second(std::string("{\"id\":1,\"result\":{}}"));
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

  suite.cases.push_back({"parseTenantFromPath extracts the tenant segment", []() {
    assertTrue(CDPServer::parseTenantFromPath("/tenant/3").value_or(999) == 3u, "/tenant/3 -> 3");
    assertTrue(CDPServer::parseTenantFromPath("/devtools/tenant/12/page").value_or(999) == 12u,
               "nested path -> 12");
    assertFalse(CDPServer::parseTenantFromPath("/").has_value(), "no marker -> none");
    assertFalse(CDPServer::parseTenantFromPath("/tenant/").has_value(), "no digits -> none");
    assertFalse(CDPServer::parseTenantFromPath("").has_value(), "empty -> none");
  }});

  suite.cases.push_back({"a connection bound via /tenant/{id} routes to that tenant's target", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(5, "App 5");
    svc.registerDebugTarget(5, target);
    // Without the path binding this connection would default to tenant 0 and the
    // Debugger request would miss tenant 5's target entirely.
    transport->simulateConnect(710, "/tenant/5");
    transport->simulateMessage(710, R"({"id":1,"method":"Debugger.enable"})");
    assertEqual(target->received.size(), size_t(1), "tenant 5 target received the request");
    svc.stop();
  }});

  // --- async / persistent-sink contract (Phase-3 T2.1 seam evolution) ---

  suite.cases.push_back({"async out-of-band emit reaches the client via the persistent sink", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    assertEqual(target->dispatched.size(), size_t(1), "request dispatched");
    assertEqual(transport->sent.size(), size_t(0), "target replied nothing inside dispatch");
    // Later, out of band (as a real agent would), the target emits an event.
    target->emit(700, R"({"method":"Debugger.paused","params":{}})");
    assertEqual(transport->sent.size(), size_t(1), "out-of-band event forwarded to the client");
    assertTrue(transport->sent[0].second.find("Debugger.paused") != std::string::npos, "the event");
    svc.stop();
  }});

  suite.cases.push_back({"onClientConnect fires once per connection", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    transport->simulateMessage(700, R"({"id":2,"method":"Debugger.resume"})");
    assertEqual(target->connectCount, 1, "onClientConnect only once");
    assertEqual(target->dispatched.size(), size_t(2), "both requests dispatched");
    svc.stop();
  }});

  suite.cases.push_back({"disconnect tears down the sink; a later emit is dropped", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    transport->simulateDisconnect(700);
    assertEqual(target->disconnectCount, 1, "onClientDisconnect fired");
    const size_t before = transport->sent.size();
    target->emit(700, R"({"method":"Debugger.paused","params":{}})");
    assertEqual(transport->sent.size(), before, "emit after disconnect is dropped");
    svc.stop();
  }});

  suite.cases.push_back({"two connections to one tenant get independent sinks", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateConnect(701);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    transport->simulateMessage(701, R"({"id":1,"method":"Debugger.enable"})");
    assertEqual(target->connectCount, 2, "one onClientConnect per connection");
    target->emit(700, R"({"method":"Debugger.paused","params":{}})");
    assertEqual(transport->sent.size(), size_t(1), "only conn 700's sink fired");
    assertEqual(transport->sent[0].first, ConnectionId(700), "routed to conn 700");
    svc.stop();
  }});

  suite.cases.push_back({"the persistent sink routes to its exact connection", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateConnect(701);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    transport->simulateMessage(701, R"({"id":1,"method":"Debugger.enable"})");
    target->emit(701, R"({"method":"Debugger.resumed","params":{}})");
    assertEqual(transport->sent.size(), size_t(1), "one message");
    assertEqual(transport->sent[0].first, ConnectionId(701), "routed to conn 701");
    svc.stop();
  }});

  suite.cases.push_back({"the /json discovery endpoint is served over the injected transport", []() {
    auto transport = std::make_shared<MockTransport>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(4, "App D");
    // chrome://inspect probes /json through the transport's HTTP-GET seam.
    HttpResponse r = transport->simulateHttpGet("GET", "/json");
    assertEqual(r.status, 200, "200 for /json");
    assertTrue(r.body.find("App D") != std::string::npos, "the tenant is discoverable");
    assertEqual(transport->simulateHttpGet("POST", "/json").status, 405, "non-GET -> 405");
    svc.stop();
  }});

  suite.cases.push_back({"unregisterDebugTarget disconnects its bound clients", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<AsyncFakeTarget>();
    DevToolsService svc(transport);
    svc.start();
    svc.onTenantCreated(0, "App");
    svc.registerDebugTarget(0, target);
    transport->simulateConnect(700);
    transport->simulateMessage(700, R"({"id":1,"method":"Debugger.enable"})");
    assertEqual(target->connectCount, 1, "client bound");
    svc.server().unregisterDebugTarget(0);
    assertEqual(target->disconnectCount, 1, "unregister disconnected the bound client");
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
