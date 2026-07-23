/**
 * test_engine_debug_target.cpp
 *
 * Unit tests for the IEngineDebugTarget relay seam (Phase-2 T2.1).
 */
#include "test_framework.h"
#include "../src/devtools/EngineDebugTarget.h"
#include "../src/devtools/CDPServer.h"

#include <memory>
#include <unordered_map>
#include <vector>

using namespace rill::devtools;
using namespace rill::test;

namespace {

// Models the CDPAgentTarget passthrough shape: owns Runtime+Debugger and, on a
// request, emits a verbatim response plus (optionally) one event. A real agent
// parses ids/methods; here we only prove the seam's contract and message shape.
class FakeAgentTarget : public IEngineDebugTarget {
public:
  bool emitEvent = true;

  DomainSet ownedDomains() const override {
    DomainSet d;
    d.runtime = true;
    d.debugger = true;
    return d;
  }

  void onClientConnect(ConnectionId conn, CdpOutboundFn sink) override {
    sinks_[conn] = std::move(sink);
  }
  void onClientDisconnect(ConnectionId conn) override { sinks_.erase(conn); }

  void dispatch(ConnectionId conn, const RawCdpMessage& req) override {
    (void)req;
    auto it = sinks_.find(conn);
    if (it == sinks_.end()) return;
    const auto& out = it->second;
    out(std::string("{\"id\":1,\"result\":{}}"));
    if (emitEvent) {
      out(std::string("{\"method\":\"Debugger.scriptParsed\",\"params\":{}}"));
    }
  }

private:
  std::unordered_map<ConnectionId, CdpOutboundFn> sinks_;
};

TestSuite createEngineDebugTargetTests() {
  TestSuite suite{"EngineDebugTarget", {}};

  suite.cases.push_back({"DomainSet::owns reflects owned domains", []() {
    FakeAgentTarget t;
    DomainSet d = t.ownedDomains();
    assertTrue(d.owns("Runtime"), "owns Runtime");
    assertTrue(d.owns("Debugger"), "owns Debugger");
    assertFalse(d.owns("Profiler"), "not Profiler");
    assertFalse(d.owns("DOM"), "not DOM (local handler)");
    assertFalse(d.owns("Nonsense"), "unknown domain");
  }});

  suite.cases.push_back({"dispatch emits response + event through the persistent sink", []() {
    FakeAgentTarget t;
    std::vector<std::string> out;
    t.onClientConnect(1, [&](const RawCdpMessage& m) { out.push_back(m); });
    t.dispatch(1, "{\"id\":1,\"method\":\"Runtime.evaluate\"}");
    assertEqual(out.size(), size_t(2), "response + event");
    assertTrue(out[0].find("\"result\"") != std::string::npos, "first is a response");
    assertTrue(out[1].find("scriptParsed") != std::string::npos, "second is an event");
  }});

  suite.cases.push_back({"a target may emit response only (0 events)", []() {
    FakeAgentTarget t;
    t.emitEvent = false;
    std::vector<std::string> out;
    t.onClientConnect(1, [&](const RawCdpMessage& m) { out.push_back(m); });
    t.dispatch(1, "{\"id\":2,\"method\":\"Debugger.enable\"}");
    assertEqual(out.size(), size_t(1), "just the response, no events");
  }});

  // --- CDPServer integration: the domain-ownership multiplexer ---

  suite.cases.push_back({"CDPServer forwards an owned-domain request verbatim", []() {
    struct MockTransport : public CDPTransport {
      std::vector<std::pair<ConnectionId, std::string>> sent;
      bool start(const std::string&, uint16_t) override { return true; }
      void stop() override {}
      void send(ConnectionId c, const std::string& m) override { sent.push_back({c, m}); }
      void close(ConnectionId) override {}
      void simulateConnect(ConnectionId c, const std::string& path = "") { if (onConnect_) onConnect_(c, path); }
      void simulateMessage(ConnectionId c, const std::string& m) { if (onMessage_) onMessage_(c, m); }
    };
    // Records what it received; replies with a recognizable response + event.
    struct RecordingTarget : public IEngineDebugTarget {
      std::vector<std::string> received;
      std::unordered_map<ConnectionId, CdpOutboundFn> sinks;
      DomainSet ownedDomains() const override {
        DomainSet d; d.runtime = true; d.debugger = true; return d;
      }
      void onClientConnect(ConnectionId c, CdpOutboundFn s) override { sinks[c] = std::move(s); }
      void onClientDisconnect(ConnectionId c) override { sinks.erase(c); }
      void dispatch(ConnectionId c, const RawCdpMessage& req) override {
        received.push_back(req);
        auto it = sinks.find(c); if (it == sinks.end()) return;
        it->second(std::string("{\"id\":7,\"result\":{\"from\":\"target\"}}"));
        it->second(std::string("{\"method\":\"Debugger.scriptParsed\",\"params\":{}}"));
      }
    };

    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;
    CDPServer server(config);
    server.registerDebugTarget(0, target);  // tenant 0 (requests carry no sessionId)
    server.start();
    transport->simulateConnect(500);

    transport->simulateMessage(500, R"({"id":7,"method":"Debugger.enable"})");

    assertEqual(target->received.size(), size_t(1), "target received the request");
    assertTrue(target->received[0].find("Debugger.enable") != std::string::npos, "verbatim request");
    assertEqual(transport->sent.size(), size_t(2), "target response + event forwarded");
    assertTrue(transport->sent[0].second.find("\"from\":\"target\"") != std::string::npos,
               "response came from the target, not a local handler");
    assertTrue(transport->sent[1].second.find("scriptParsed") != std::string::npos, "event forwarded");
    server.stop();
  }});

  suite.cases.push_back({"CDPServer keeps a non-owned domain on the local handler", []() {
    struct MockTransport : public CDPTransport {
      std::vector<std::pair<ConnectionId, std::string>> sent;
      bool start(const std::string&, uint16_t) override { return true; }
      void stop() override {}
      void send(ConnectionId c, const std::string& m) override { sent.push_back({c, m}); }
      void close(ConnectionId) override {}
      void simulateConnect(ConnectionId c, const std::string& path = "") { if (onConnect_) onConnect_(c, path); }
      void simulateMessage(ConnectionId c, const std::string& m) { if (onMessage_) onMessage_(c, m); }
    };
    struct RecordingTarget : public IEngineDebugTarget {
      std::vector<std::string> received;
      DomainSet ownedDomains() const override {
        DomainSet d; d.runtime = true; d.debugger = true; return d;  // NOT DOM
      }
      void onClientConnect(ConnectionId, CdpOutboundFn) override {}
      void onClientDisconnect(ConnectionId) override {}
      void dispatch(ConnectionId, const RawCdpMessage& req) override {
        received.push_back(req);
      }
    };

    auto transport = std::make_shared<MockTransport>();
    auto target = std::make_shared<RecordingTarget>();
    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;
    CDPServer server(config);
    server.registerDebugTarget(0, target);
    server.start();
    transport->simulateConnect(501);

    transport->simulateMessage(501, R"({"id":8,"method":"DOM.enable"})");

    assertEqual(target->received.size(), size_t(0), "DOM not forwarded to the Runtime/Debugger target");
    assertTrue(transport->sent.size() >= 1, "local DOM handler produced a response");
    server.stop();
  }});

  return suite;
}

}  // anonymous namespace

// Register with the test runner (static-init self-registration).
static struct EngineDebugTargetRegistrar {
  EngineDebugTargetRegistrar() {
    TestRunner::instance().addSuite(createEngineDebugTargetTests());
  }
} s_engineDebugTargetRegistrar;
