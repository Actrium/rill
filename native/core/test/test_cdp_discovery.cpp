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

// A transport that, like CDPTransportApple, serves discovery on the configured
// port and moves the ws surface to the sibling port.
struct SplitPortTransport : public MockTransport {
  uint16_t webSocketPort(uint16_t configuredPort) const override {
    return static_cast<uint16_t>(configuredPort + 1);
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

// Pull the sessionId out of the FIRST message at index >= from that carries one.
std::string sessionIdFrom(const std::vector<std::pair<ConnectionId, std::string>>& sent,
                          size_t from) {
  for (size_t i = from; i < sent.size(); ++i) {
    auto sid = cdp::parseJSONString(sent[i].second, "sessionId");
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

  // --- parseRequestLine (HTTP request-line parsing) -------------------------

  suite.cases.push_back({"parseRequestLine extracts method and path from a full request", []() {
    std::string method, path;
    bool ok = cdp::parseRequestLine("GET /json/list HTTP/1.1\r\nHost: x\r\n\r\n", method, path);
    assertTrue(ok, "parsed");
    assertEqual(method, std::string("GET"), "method GET");
    assertEqual(path, std::string("/json/list"), "path /json/list");
  }});

  suite.cases.push_back({"parseRequestLine strips a query string from the path", []() {
    std::string method, path;
    bool ok = cdp::parseRequestLine("GET /json?foo=1 HTTP/1.1", method, path);
    assertTrue(ok, "parsed");
    assertEqual(method, std::string("GET"), "method GET");
    assertEqual(path, std::string("/json"), "query stripped");
  }});

  suite.cases.push_back({"parseRequestLine strips a fragment from the path", []() {
    std::string method, path;
    bool ok = cdp::parseRequestLine("GET /json/version#frag HTTP/1.1", method, path);
    assertTrue(ok, "parsed");
    assertEqual(path, std::string("/json/version"), "fragment stripped");
  }});

  suite.cases.push_back({"parseRequestLine keeps the method verb (POST)", []() {
    std::string method, path;
    bool ok = cdp::parseRequestLine("POST /json", method, path);
    assertTrue(ok, "parsed (missing CRLF and version tolerated)");
    assertEqual(method, std::string("POST"), "method POST");
    assertEqual(path, std::string("/json"), "path /json");
  }});

  suite.cases.push_back({"parseRequestLine rejects malformed request lines", []() {
    std::string method, path;
    assertTrue(!cdp::parseRequestLine("GET", method, path), "single token -> false");
    assertTrue(!cdp::parseRequestLine("", method, path), "empty -> false");
    assertTrue(!cdp::parseRequestLine("   \r\n", method, path), "spaces only -> false");
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

  // --- split-port transports (Apple): ws urls point at the real ws port ------

  suite.cases.push_back({"webSocketDebuggerUrl follows the transport's ws port; discovery keeps the configured port", []() {
    auto transport = std::make_shared<SplitPortTransport>();
    CDPServerConfig cfg;
    cfg.host = "127.0.0.1";
    cfg.port = 9229;
    cfg.transport = transport;
    CDPServer server(cfg);
    server.registerTenant(1, "App A");

    assertEqual(server.getPort(), uint16_t(9229), "configured (discovery) port");
    assertEqual(server.getWebSocketPort(), uint16_t(9230), "ws surface on the sibling port");
    // Discovery itself stays on the configured port (chrome://inspect probes it).
    assertEqual(server.getTargetListUrl(), std::string("http://127.0.0.1:9229/json"), "discovery url");
    // Every ws url the server hands out points at the REAL ws listener.
    assertEqual(server.getWebSocketUrl(1), std::string("ws://127.0.0.1:9230/tenant/1"), "per-tenant ws url");
    HttpResponse version = server.handleDiscoveryRequest("GET", "/json/version");
    assertTrue(version.body.find("\"ws://127.0.0.1:9230/\"") != std::string::npos, "root ws url on ws port");
    HttpResponse list = server.handleDiscoveryRequest("GET", "/json/list");
    assertTrue(list.body.find("ws://127.0.0.1:9230/tenant/1") != std::string::npos, "list ws url on ws port");
    assertTrue(list.body.find(":9229/tenant/") == std::string::npos, "no ws url leaks the discovery port");
  }});

  // --- one socket, several attached sessions ---------------------------------

  suite.cases.push_back({"two sessions on one socket route to their own tenants with their own sinks", []() {
    auto transport = std::make_shared<MockTransport>();
    auto targetA = std::make_shared<RecordingTarget>();
    auto targetB = std::make_shared<RecordingTarget>();
    CDPServerConfig cfg;
    cfg.enabled = true;
    cfg.transport = transport;
    CDPServer server(cfg);
    server.registerTenant(1, "App A");
    server.registerTenant(2, "App B");
    server.registerDebugTarget(1, targetA);
    server.registerDebugTarget(2, targetB);
    server.start();

    const ConnectionId kConn = 900;
    transport->simulateConnect(kConn);

    // Attach to both tenants over the SAME socket.
    size_t mark = transport->sent.size();
    transport->simulateMessage(kConn, R"({"id":1,"method":"Target.attachToTarget","params":{"targetId":"1","flatten":true}})");
    std::string sidA = sessionIdFrom(transport->sent, mark);
    mark = transport->sent.size();
    transport->simulateMessage(kConn, R"({"id":2,"method":"Target.attachToTarget","params":{"targetId":"2","flatten":true}})");
    std::string sidB = sessionIdFrom(transport->sent, mark);
    assertTrue(!sidA.empty() && !sidB.empty() && sidA != sidB, "two distinct sessionIds");

    // Each session's Debugger.* lands in ITS tenant's target — including the
    // second one, which must get its own agent/sink rather than being dropped.
    transport->simulateMessage(kConn, std::string("{\"id\":3,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sidA + "\"}");
    transport->simulateMessage(kConn, std::string("{\"id\":4,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sidB + "\"}");
    assertEqual(targetA->received.size(), size_t(1), "tenant 1 got its request");
    assertEqual(targetB->received.size(), size_t(1), "tenant 2 got its request (not starved)");
    assertEqual(targetA->sinks.size(), size_t(1), "tenant 1 target has its own client");
    assertEqual(targetB->sinks.size(), size_t(1), "tenant 2 target has its own client");

    // Replies are tagged with the RIGHT sessionId per session.
    transport->sent.clear();
    transport->simulateMessage(kConn, std::string("{\"id\":5,\"method\":\"Debugger.resume\",\"sessionId\":\"") + sidB + "\"}");
    assertTrue(transport->sent.back().second.find(sidB) != std::string::npos, "reply tagged with session B");
    assertTrue(transport->sent.back().second.find(sidA) == std::string::npos, "not tagged with session A");

    // Detach session A: its target connection is released (onClientDisconnect),
    // session B keeps working untouched.
    transport->simulateMessage(kConn, std::string("{\"id\":6,\"method\":\"Target.detachFromTarget\",\"params\":{\"sessionId\":\"") + sidA + "\"}}");
    assertEqual(targetA->sinks.size(), size_t(0), "detach released tenant 1's client connection");
    assertEqual(targetB->sinks.size(), size_t(1), "tenant 2's client survives A's detach");
    transport->simulateMessage(kConn, std::string("{\"id\":7,\"method\":\"Debugger.resume\",\"sessionId\":\"") + sidB + "\"}");
    assertEqual(targetB->received.size(), size_t(3), "session B still routes after A detached");

    // Socket teardown sweeps the remaining attached session.
    transport->simulateDisconnect(kConn);
    assertEqual(targetB->sinks.size(), size_t(0), "disconnect released tenant 2's client connection");
    assertEqual(server.getSessionCount(), size_t(0), "no sessions survive the socket");
    server.stop();
  }});

  suite.cases.push_back({"two sessions attached to the SAME tenant are separate clients to its target", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    CDPServerConfig cfg;
    cfg.enabled = true;
    cfg.transport = transport;
    CDPServer server(cfg);
    server.registerTenant(5, "App");
    server.registerDebugTarget(5, target);
    server.start();

    const ConnectionId kConn = 901;
    transport->simulateConnect(kConn);
    size_t mark = transport->sent.size();
    transport->simulateMessage(kConn, R"({"id":1,"method":"Target.attachToTarget","params":{"targetId":"5","flatten":true}})");
    std::string sid1 = sessionIdFrom(transport->sent, mark);
    mark = transport->sent.size();
    transport->simulateMessage(kConn, R"({"id":2,"method":"Target.attachToTarget","params":{"targetId":"5","flatten":true}})");
    std::string sid2 = sessionIdFrom(transport->sent, mark);
    assertTrue(!sid1.empty() && !sid2.empty() && sid1 != sid2, "distinct sessions");

    transport->simulateMessage(kConn, std::string("{\"id\":3,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sid1 + "\"}");
    transport->simulateMessage(kConn, std::string("{\"id\":4,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sid2 + "\"}");
    assertEqual(target->sinks.size(), size_t(2), "one client connection per session");

    // The second session's replies carry ITS id, not the first one's.
    transport->sent.clear();
    transport->simulateMessage(kConn, std::string("{\"id\":5,\"method\":\"Debugger.resume\",\"sessionId\":\"") + sid2 + "\"}");
    assertTrue(transport->sent.back().second.find(sid2) != std::string::npos, "tagged with its own session");
    assertTrue(transport->sent.back().second.find(sid1) == std::string::npos, "not the sibling session");

    transport->simulateDisconnect(kConn);
    assertEqual(target->sinks.size(), size_t(0), "disconnect sweeps both sessions' clients");
    server.stop();
  }});

  suite.cases.push_back({"unregisterDebugTarget and stop release attached sessions' target connections", []() {
    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    CDPServerConfig cfg;
    cfg.enabled = true;
    cfg.transport = transport;
    CDPServer server(cfg);
    server.registerTenant(6, "App");
    server.registerDebugTarget(6, target);
    server.start();

    const ConnectionId kConn = 902;
    transport->simulateConnect(kConn);
    size_t mark = transport->sent.size();
    transport->simulateMessage(kConn, R"({"id":1,"method":"Target.attachToTarget","params":{"targetId":"6","flatten":true}})");
    std::string sid = sessionIdFrom(transport->sent, mark);
    transport->simulateMessage(kConn, std::string("{\"id\":2,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sid + "\"}");
    assertEqual(target->sinks.size(), size_t(1), "attached session bound to the target");

    // Unregistering the tenant's target must release the session's virtual
    // connection, not just the raw-socket bindings.
    server.unregisterDebugTarget(6);
    assertEqual(target->sinks.size(), size_t(0), "unregisterDebugTarget released the session's client");
    // The session itself survives; its Debugger.* now falls back to the local
    // handler instead of the (gone) target.
    transport->simulateMessage(kConn, std::string("{\"id\":3,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sid + "\"}");
    assertEqual(target->received.size(), size_t(1), "no dispatch into an unregistered target");

    // Re-register, rebind on next request, then stop() must sweep it too.
    server.registerDebugTarget(6, target);
    transport->simulateMessage(kConn, std::string("{\"id\":4,\"method\":\"Debugger.enable\",\"sessionId\":\"") + sid + "\"}");
    assertEqual(target->sinks.size(), size_t(1), "rebound after re-register");
    server.stop();
    assertEqual(target->sinks.size(), size_t(0), "stop() released the rebound client");
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
