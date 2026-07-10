/**
 * test_cdp_discovery.cpp
 *
 * Phase-4 G: the portable half of CDP target discovery + tenant routing.
 *   - cdp::buildHttpResponse framing
 *   - CDPServer::handleDiscoveryRequest (/json family, GET-only, 404/405)
 *   - the transport HTTP-GET seam (CDPTransport::onHttpGet_)
 *   - the Target-domain sessionId multiplex: setDiscoverTargets ->
 *     Target.targetCreated -> attachToTarget -> Debugger.* carrying the sessionId
 *     landing in the tenant's debug target -> detachFromTarget dropping it.
 */
#include "test_framework.h"
#include "../src/devtools/CDPServer.h"
#include "../src/devtools/EngineDebugTarget.h"

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

using namespace rill::devtools;
using namespace rill::test;

namespace {

// A transport that lets a test drive the CDPServer callbacks directly, including
// the new HTTP-GET discovery seam.
struct MockTransport : public CDPTransport {
  bool started = false;
  std::vector<std::pair<ConnectionId, std::string>> sent;

  bool start(const std::string&, uint16_t) override { started = true; return true; }
  void stop() override {}
  void send(ConnectionId c, const std::string& m) override { sent.push_back({c, m}); }
  void close(ConnectionId) override {}

  void simulateConnect(ConnectionId c, const std::string& path = "") {
    if (onConnect_) onConnect_(c, path);
  }
  void simulateMessage(ConnectionId c, const std::string& m) {
    if (onMessage_) onMessage_(c, m);
  }
  void simulateDisconnect(ConnectionId c) {
    if (onDisconnect_) onDisconnect_(c);
  }
  HttpResponse simulateHttpGet(const std::string& method, const std::string& path) {
    return onHttpGet_ ? onHttpGet_(method, path) : HttpResponse{404, "Not Found", "", ""};
  }
};

// Owns the Debugger domain: records the raw requests it receives and replies
// through the per-connection persistent sink installed at onClientConnect.
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

// Pull the first "sessionId" value out of a sequence of sent messages.
std::string firstSessionId(const std::vector<std::pair<ConnectionId, std::string>>& sent) {
  for (const auto& [c, m] : sent) {
    (void)c;
    auto sid = cdp::parseJSONString(m, "sessionId");
    if (sid) return *sid;
  }
  return {};
}

TestSuite createCDPDiscoveryTests() {
  TestSuite suite{"CDPDiscovery", {}};

  // --- HTTP response framing -------------------------------------------------

  suite.cases.push_back({"buildHttpResponse frames status line, headers and body", []() {
    HttpResponse r;
    r.status = 200;
    r.statusText = "OK";
    r.contentType = "application/json";
    r.body = "[]";
    std::string wire = cdp::buildHttpResponse(r);
    assertTrue(wire.rfind("HTTP/1.1 200 OK\r\n", 0) == 0, "status line first");
    assertTrue(wire.find("Content-Type: application/json\r\n") != std::string::npos, "content-type");
    assertTrue(wire.find("Content-Length: 2\r\n") != std::string::npos, "content-length matches body");
    assertTrue(wire.find("\r\n\r\n[]") != std::string::npos, "blank line then body");
    // Loopback-only: no CORS/wildcard header leaks discovery cross-origin.
    assertTrue(wire.find("Access-Control-Allow-Origin") == std::string::npos, "no CORS header");
  }});

  suite.cases.push_back({"buildHttpResponse frames a 404", []() {
    HttpResponse r;
    r.status = 404;
    r.statusText = "Not Found";
    r.body = "";
    std::string wire = cdp::buildHttpResponse(r);
    assertTrue(wire.rfind("HTTP/1.1 404 Not Found\r\n", 0) == 0, "404 status line");
    assertTrue(wire.find("Content-Length: 0\r\n") != std::string::npos, "zero length");
  }});

  // --- handleDiscoveryRequest routing ---------------------------------------

  suite.cases.push_back({"handleDiscoveryRequest rejects non-GET with 405", []() {
    CDPServer server;
    HttpResponse r = server.handleDiscoveryRequest("POST", "/json");
    assertEqual(r.status, 405, "POST -> 405");
    HttpResponse r2 = server.handleDiscoveryRequest("DELETE", "/json/version");
    assertEqual(r2.status, 405, "DELETE -> 405");
  }});

  suite.cases.push_back({"handleDiscoveryRequest 404s unknown paths", []() {
    CDPServer server;
    assertEqual(server.handleDiscoveryRequest("GET", "/nope").status, 404, "unknown -> 404");
    assertEqual(server.handleDiscoveryRequest("GET", "/").status, 404, "root -> 404");
  }});

  suite.cases.push_back({"/json/version advertises a single root webSocketDebuggerUrl", []() {
    CDPServerConfig cfg;
    cfg.host = "127.0.0.1";
    cfg.port = 9229;
    CDPServer server(cfg);
    HttpResponse r = server.handleDiscoveryRequest("GET", "/json/version");
    assertEqual(r.status, 200, "200");
    assertTrue(r.body.find("Rill/1.0") != std::string::npos, "browser");
    assertTrue(r.body.find("Protocol-Version") != std::string::npos, "protocol version");
    // A single ROOT url with a trailing slash and no tenant path.
    assertTrue(r.body.find("\"ws://127.0.0.1:9229/\"") != std::string::npos, "root ws url");
    assertTrue(r.body.find("/tenant/") == std::string::npos, "no tenant path in version");
  }});

  suite.cases.push_back({"/json/protocol returns an empty domain list", []() {
    CDPServer server;
    HttpResponse r = server.handleDiscoveryRequest("GET", "/json/protocol");
    assertEqual(r.status, 200, "200");
    assertTrue(r.body.find("\"domains\"") != std::string::npos, "domains key");
  }});

  // --- /json list reflects tenant registration ------------------------------

  suite.cases.push_back({"/json/list reflects registerTenant/unregisterTenant with full descriptor", []() {
    CDPServerConfig cfg;
    cfg.host = "127.0.0.1";
    cfg.port = 9229;
    CDPServer server(cfg);
    server.registerTenant(1, "App A");

    HttpResponse r = server.handleDiscoveryRequest("GET", "/json/list");
    assertEqual(r.status, 200, "200");
    // Descriptor shape: {id,title,url,type,webSocketDebuggerUrl,devtoolsFrontendUrl}.
    assertTrue(r.body.find("\"id\":\"1\"") != std::string::npos, "id");
    assertTrue(r.body.find("App A") != std::string::npos, "title");
    assertTrue(r.body.find("\"type\":\"node\"") != std::string::npos, "type node");
    assertTrue(r.body.find("\"url\":\"") != std::string::npos, "url");
    assertTrue(r.body.find("ws://127.0.0.1:9229/tenant/1") != std::string::npos, "per-tenant ws url");
    assertTrue(r.body.find("devtoolsFrontendUrl") != std::string::npos, "devtools frontend url");

    server.unregisterTenant(1);
    HttpResponse r2 = server.handleDiscoveryRequest("GET", "/json/list");
    assertTrue(r2.body.find("App A") == std::string::npos, "gone after unregister");
    assertTrue(r2.body == "[]", "empty list");
  }});

  suite.cases.push_back({"handleHttpRequest shim delegates to discovery (body only, 404==empty)", []() {
    CDPServer server;
    server.registerTenant(2, "App B");
    assertTrue(server.handleHttpRequest("/json").find("App B") != std::string::npos, "body for /json");
    assertTrue(server.handleHttpRequest("/json/version").find("Rill/1.0") != std::string::npos, "version body");
    assertEqual(server.handleHttpRequest("/nope"), std::string(), "404 -> empty");
  }});

  // --- transport HTTP-GET seam ----------------------------------------------

  suite.cases.push_back({"a GET flows through the transport onHttpGet seam", []() {
    auto transport = std::make_shared<MockTransport>();
    CDPServerConfig cfg;
    cfg.enabled = true;
    cfg.transport = transport;
    CDPServer server(cfg);
    server.registerTenant(3, "App C");
    server.start();

    HttpResponse r = transport->simulateHttpGet("GET", "/json/list");
    assertEqual(r.status, 200, "200 via seam");
    assertTrue(r.body.find("App C") != std::string::npos, "tenant reflected through seam");

    HttpResponse bad = transport->simulateHttpGet("PUT", "/json");
    assertEqual(bad.status, 405, "non-GET via seam -> 405");
    server.stop();
  }});

  // --- full Target-attach sessionId multiplex flow --------------------------

  suite.cases.push_back({"discover -> targetCreated -> attach -> Debugger.* routes -> detach drops it", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    CDPServerConfig cfg;
    cfg.enabled = true;
    cfg.transport = transport;
    CDPServer server(cfg);
    const TenantId kTenant = 7;
    server.registerTenant(kTenant, "App 7");
    server.registerDebugTarget(kTenant, target);
    server.start();

    // A root browser connection (no /tenant path): tenant routing is by sessionId.
    const ConnectionId kConn = 800;
    transport->simulateConnect(kConn);

    // 1. Enable discovery -> Target.targetCreated for the existing tenant.
    transport->simulateMessage(kConn, R"({"id":1,"method":"Target.setDiscoverTargets","params":{"discover":true}})");
    bool sawCreated = false;
    for (const auto& [c, m] : transport->sent) {
      (void)c;
      if (m.find("Target.targetCreated") != std::string::npos &&
          m.find("\"targetId\":\"7\"") != std::string::npos) {
        sawCreated = true;
      }
    }
    assertTrue(sawCreated, "targetCreated for tenant 7 emitted to the discovering client");

    // A tenant registered LATER also reaches the discovering client.
    server.registerTenant(9, "App 9");
    bool sawLater = false;
    for (const auto& [c, m] : transport->sent) {
      (void)c;
      if (m.find("Target.targetCreated") != std::string::npos &&
          m.find("\"targetId\":\"9\"") != std::string::npos) {
        sawLater = true;
      }
    }
    assertTrue(sawLater, "targetCreated for a later tenant reaches the discovering client");

    // 2. Attach to tenant 7 -> reply carries a sessionId (+ attachedToTarget).
    transport->simulateMessage(kConn, R"({"id":2,"method":"Target.attachToTarget","params":{"targetId":"7","flatten":true}})");
    std::string sessionId = firstSessionId(transport->sent);
    assertTrue(!sessionId.empty(), "attachToTarget produced a sessionId");
    bool sawAttached = false;
    for (const auto& [c, m] : transport->sent) {
      (void)c;
      if (m.find("Target.attachedToTarget") != std::string::npos) sawAttached = true;
    }
    assertTrue(sawAttached, "Target.attachedToTarget emitted");

    // 3. A Debugger request carrying that sessionId lands in tenant 7's target.
    const size_t sentBefore = transport->sent.size();
    std::string dbg = std::string("{\"id\":3,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sessionId + "\"}";
    transport->simulateMessage(kConn, dbg);
    assertEqual(target->received.size(), size_t(1), "the owned-domain request reached tenant 7");
    assertTrue(target->received[0].find("Debugger.enable") != std::string::npos, "the raw request forwarded");
    assertTrue(transport->sent.size() > sentBefore, "target's reply forwarded to the client");
    // The reply is tagged with the session's id (flatten-mode demultiplexing).
    assertTrue(transport->sent.back().second.find(sessionId) != std::string::npos, "reply carries sessionId");

    // 4. Detach drops the session: a later Debugger.* with that id no longer
    //    routes to the target — it is answered with an error instead.
    std::string detach = std::string("{\"id\":4,\"method\":\"Target.detachFromTarget\",\"params\":{\"sessionId\":\"") + sessionId + "\"}}";
    transport->simulateMessage(kConn, detach);
    std::string after = std::string("{\"id\":5,\"method\":\"Debugger.resume\",\"sessionId\":\"") + sessionId + "\"}";
    transport->simulateMessage(kConn, after);
    assertEqual(target->received.size(), size_t(1), "no further requests reach the detached tenant");
    assertTrue(transport->sent.back().second.find("error") != std::string::npos, "unknown session -> error");

    transport->simulateDisconnect(kConn);
    server.stop();
  }});

  suite.cases.push_back({"injectSessionId adds a sessionId only when absent", []() {
    assertTrue(cdp::injectSessionId("{\"id\":1,\"result\":{}}", "S")
                   .find("\"sessionId\":\"S\"") != std::string::npos, "added to non-empty object");
    assertTrue(cdp::injectSessionId("{}", "S") == std::string("{\"sessionId\":\"S\"}"),
               "added to empty object without stray comma");
    // Idempotent: an already-tagged message is untouched.
    std::string tagged = "{\"method\":\"Debugger.paused\",\"sessionId\":\"X\"}";
    assertEqual(cdp::injectSessionId(tagged, "S"), tagged, "already tagged -> unchanged");
  }});

  return suite;
}

}  // anonymous namespace

static struct CDPDiscoveryRegistrar {
  CDPDiscoveryRegistrar() {
    TestRunner::instance().addSuite(createCDPDiscoveryTests());
  }
} s_cdpDiscoveryRegistrar;
