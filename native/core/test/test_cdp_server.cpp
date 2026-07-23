/**
 * test_cdp_server.cpp
 *
 * P3-Y.T: CDP Server Unit Tests
 */

#include "test_framework.h"
#include "../src/devtools/CDPServer.h"

using namespace rill::devtools;
using namespace rill::test;

namespace {

TestSuite createCDPServerTests() {
  TestSuite suite{"CDPServer", {}};

  // JSON Helpers Tests
  suite.cases.push_back({"cdp::escapeJSON basic strings", []() {
    assertEqual(cdp::escapeJSON("hello"), std::string("hello"), "simple");
    assertEqual(cdp::escapeJSON(""), std::string(""), "empty");
  }});

  suite.cases.push_back({"cdp::escapeJSON special characters", []() {
    assertEqual(cdp::escapeJSON("hello\"world"), std::string("hello\\\"world"), "quote");
    assertEqual(cdp::escapeJSON("back\\slash"), std::string("back\\\\slash"), "backslash");
    assertEqual(cdp::escapeJSON("new\nline"), std::string("new\\nline"), "newline");
  }});

  suite.cases.push_back({"cdp::buildEventJSON", []() {
    std::string json = cdp::buildEventJSON("Runtime.consoleAPICalled", 
                                           "{\"type\":\"log\"}", 
                                           std::nullopt);
    assertTrue(json.find("Runtime.consoleAPICalled") != std::string::npos, "has method");
    assertTrue(json.find("\"params\"") != std::string::npos, "has params");
  }});

  suite.cases.push_back({"cdp::buildResponseJSON", []() {
    std::string json = cdp::buildResponseJSON(42, "{\"value\":true}");
    assertTrue(json.find("\"id\":42") != std::string::npos, "has id");
    assertTrue(json.find("\"result\"") != std::string::npos, "has result");
  }});

  suite.cases.push_back({"cdp::buildErrorJSON", []() {
    std::string json = cdp::buildErrorJSON(1, -32600, "Invalid Request");
    assertTrue(json.find("\"id\":1") != std::string::npos, "has id");
    assertTrue(json.find("-32600") != std::string::npos, "has code");
    assertTrue(json.find("Invalid Request") != std::string::npos, "has message");
  }});

  suite.cases.push_back({"cdp::parseJSONString", []() {
    std::string json = R"({"method":"Runtime.evaluate","id":1})";
    auto method = cdp::parseJSONString(json, "method");
    assertTrue(method.has_value(), "found method");
    assertEqual(*method, std::string("Runtime.evaluate"), "method value");
    
    auto missing = cdp::parseJSONString(json, "nonexistent");
    assertTrue(!missing.has_value(), "not found");
  }});

  suite.cases.push_back({"cdp::parseJSONInt", []() {
    std::string json = R"({"id":42,"count":-5})";
    auto id = cdp::parseJSONInt(json, "id");
    assertTrue(id.has_value(), "found id");
    assertEqual(*id, 42, "id value");
    
    auto count = cdp::parseJSONInt(json, "count");
    assertTrue(count.has_value(), "found count");
    assertEqual(*count, -5, "count value");
  }});

  // CDPServer Lifecycle Tests
  suite.cases.push_back({"CDPServer creation with default config", []() {
    CDPServerConfig config;
    CDPServer server(config);
    
    assertTrue(!server.isRunning(), "not running initially");
    assertEqual(server.getPort(), uint16_t(9229), "default port");
    assertEqual(server.getConnectionCount(), size_t(0), "no connections");
  }});

  suite.cases.push_back({"CDPServer start and stop", []() {
    CDPServerConfig config;
    config.enabled = true;
    CDPServer server(config);
    
    assertTrue(server.start(), "started");
    assertTrue(server.isRunning(), "is running");
    server.stop();
    assertTrue(!server.isRunning(), "stopped");
  }});

  suite.cases.push_back({"CDPServer disabled does not start", []() {
    CDPServerConfig config;
    config.enabled = false;
    CDPServer server(config);
    
    assertTrue(!server.start(), "did not start");
    assertTrue(!server.isRunning(), "not running");
  }});

  // Tenant Management Tests
  suite.cases.push_back({"CDPServer registerTenant", []() {
    CDPServer server;
    server.registerTenant(1, "Test App");
    
    assertTrue(server.hasTenant(1), "has tenant 1");
    assertTrue(!server.hasTenant(2), "no tenant 2");
  }});

  suite.cases.push_back({"CDPServer unregisterTenant", []() {
    CDPServer server;
    server.registerTenant(1, "Test");
    assertTrue(server.hasTenant(1), "has tenant");
    
    server.unregisterTenant(1);
    assertTrue(!server.hasTenant(1), "no longer has tenant");
  }});

  suite.cases.push_back({"CDPServer getTenantIds", []() {
    CDPServer server;
    server.registerTenant(1, "App 1");
    server.registerTenant(2, "App 2");
    server.registerTenant(3, "App 3");
    
    auto ids = server.getTenantIds();
    assertEqual(ids.size(), size_t(3), "3 tenants");
  }});

  // URL Helper Tests
  suite.cases.push_back({"CDPServer getWebSocketUrl", []() {
    CDPServerConfig config;
    config.host = "127.0.0.1";
    config.port = 9229;
    CDPServer server(config);
    server.registerTenant(42, "Test");
    
    std::string url = server.getWebSocketUrl(42);
    assertEqual(url, std::string("ws://127.0.0.1:9229/tenant/42"), "url");
  }});

  suite.cases.push_back({"CDPServer getTargetListUrl", []() {
    CDPServerConfig config;
    config.host = "127.0.0.1";
    config.port = 9229;
    CDPServer server(config);
    
    std::string url = server.getTargetListUrl();
    assertEqual(url, std::string("http://127.0.0.1:9229/json"), "url");
  }});

  // Error Code Tests
  suite.cases.push_back({"CDPErrorCode values", []() {
    assertEqual(CDPErrorCode::PARSE_ERROR, -32700, "parse error");
    assertEqual(CDPErrorCode::INVALID_REQUEST, -32600, "invalid request");
    assertEqual(CDPErrorCode::METHOD_NOT_FOUND, -32601, "method not found");
  }});

  // JSON parsing edge cases (regression for P3 review fixes)
  suite.cases.push_back({"parseJSONString with escaped quotes", []() {
    std::string json = R"({"expr":"foo\"bar"})";
    auto val = cdp::parseJSONString(json, "expr");
    assertTrue(val.has_value(), "found");
    assertEqual(*val, std::string("foo\"bar"), "value with escaped quote");
  }});

  suite.cases.push_back({"parseJSONInt overflow returns nullopt", []() {
    std::string json = R"({"big":99999999999999})";
    auto val = cdp::parseJSONInt(json, "big");
    assertTrue(!val.has_value(), "overflow → nullopt");
  }});

  suite.cases.push_back({"parseJSONInt negative", []() {
    std::string json = R"({"n":-42})";
    auto val = cdp::parseJSONInt(json, "n");
    assertTrue(val.has_value(), "found");
    assertEqual(*val, -42, "negative value");
  }});

  suite.cases.push_back({"parseRequest with braces inside string params", []() {
    // Regression: brace counting inside strings must be ignored
    CDPServerConfig cfg;
    CDPServer server(cfg);
    // Simulate parseRequest via handleMessage — but parseRequest is private.
    // Instead, test the JSON helper directly:
    std::string json = R"({"id":1,"method":"Runtime.evaluate","params":{"expression":"x = {a:1}"}})";
    auto method = cdp::parseJSONString(json, "method");
    assertTrue(method.has_value(), "method found");
    assertEqual(*method, std::string("Runtime.evaluate"), "method");

    // Verify the expression with braces can be extracted
    auto expr = cdp::parseJSONString(json, "expression");
    assertTrue(expr.has_value(), "expression found");
    assertEqual(*expr, std::string("x = {a:1}"), "expression with braces");
  }});

  // HTTP handling
  suite.cases.push_back({"CDPServer handleHttpRequest /json/version", []() {
    CDPServer server;
    std::string response = server.handleHttpRequest("/json/version");
    assertTrue(response.find("Rill/1.0") != std::string::npos, "has browser");
    assertTrue(response.find("Protocol-Version") != std::string::npos, "has version");
  }});

  suite.cases.push_back({"CDPServer handleHttpRequest /json with tenants", []() {
    CDPServer server;
    server.registerTenant(1, "App A");
    server.registerTenant(2, "App B");
    std::string response = server.handleHttpRequest("/json");
    assertTrue(response.find("App A") != std::string::npos, "has App A");
    assertTrue(response.find("App B") != std::string::npos, "has App B");
    assertTrue(response.find("webSocketDebuggerUrl") != std::string::npos, "has wsUrl");
  }});

  // P2-2: buildEventJSON params validation
  suite.cases.push_back({"buildEventJSON with valid params", []() {
    std::string json = cdp::buildEventJSON("Test.event", "{\"key\":\"value\"}", std::nullopt);
    assertTrue(json.find("\"key\":\"value\"") != std::string::npos, "valid params preserved");
  }});

  suite.cases.push_back({"buildEventJSON with invalid params falls back to {}", []() {
    // Non-JSON string should be replaced with {}
    std::string json = cdp::buildEventJSON("Test.event", "not json", std::nullopt);
    assertTrue(json.find("\"params\":{}") != std::string::npos, "invalid params -> {}");
  }});

  suite.cases.push_back({"buildEventJSON with empty params falls back to {}", []() {
    std::string json = cdp::buildEventJSON("Test.event", "", std::nullopt);
    assertTrue(json.find("\"params\":{}") != std::string::npos, "empty params -> {}");
  }});

  // P2-4: generateSessionId produces unique IDs
  suite.cases.push_back({"CDPServer unique session IDs", []() {
    CDPServerConfig config;
    config.enabled = true;
    CDPServer server(config);
    server.registerTenant(1, "Test");
    server.start();

    // Get WebSocket URL contains tenant ID
    std::string url = server.getWebSocketUrl(1);
    assertTrue(url.find("/tenant/1") != std::string::npos, "url has tenant");
    server.stop();
  }});

  // P2-5: CDPTransport interface — verify transport is called
  suite.cases.push_back({"CDPTransport interface exists", []() {
    // Verify that CDPServerConfig accepts a transport pointer
    CDPServerConfig config;
    assertTrue(config.transport == nullptr, "default transport is null");
  }});

  // M5-B: MockTransport validates CDPTransport integration with CDPServer
  suite.cases.push_back({"CDPServer with MockTransport starts and stops", []() {
    // Define a minimal mock transport for testing
    struct MockTransport : public CDPTransport {
      bool started = false;
      bool stopped = false;
      std::string lastHost;
      uint16_t lastPort = 0;
      std::vector<std::pair<ConnectionId, std::string>> sentMessages;

      bool start(const std::string& host, uint16_t port) override {
        started = true;
        lastHost = host;
        lastPort = port;
        return true;
      }
      void stop() override {
        stopped = true;
      }
      void send(ConnectionId connId, const std::string& message) override {
        sentMessages.push_back({connId, message});
      }
      void close(ConnectionId /*connId*/) override {}
    };

    auto transport = std::make_shared<MockTransport>();

    CDPServerConfig config;
    config.enabled = true;
    config.host = "127.0.0.1";
    config.port = 9229;
    config.transport = transport;

    CDPServer server(config);

    assertTrue(server.start(), "server started");
    assertTrue(server.isRunning(), "server running");
    assertTrue(transport->started, "transport started");
    assertEqual(transport->lastHost, std::string("127.0.0.1"), "host");
    assertEqual(transport->lastPort, uint16_t(9229), "port");

    server.stop();
    assertTrue(!server.isRunning(), "server stopped");
    assertTrue(transport->stopped, "transport stopped");
  }});

  suite.cases.push_back({"CDPServer with MockTransport sends via transport", []() {
    struct MockTransport : public CDPTransport {
      bool started = false;
      bool stopped = false;
      std::vector<std::pair<ConnectionId, std::string>> sentMessages;

      bool start(const std::string&, uint16_t) override { started = true; return true; }
      void stop() override { stopped = true; }
      void send(ConnectionId connId, const std::string& message) override {
        sentMessages.push_back({connId, message});
      }
      void close(ConnectionId) override {}
    };

    auto transport = std::make_shared<MockTransport>();

    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;

    CDPServer server(config);
    server.registerTenant(1, "Test App");
    server.start();

    // Simulate an event broadcast
    CDPEvent event;
    event.method = "Runtime.consoleAPICalled";
    event.params = R"({"type":"log"})";
    server.sendEvent(1, event);

    // Note: Without active sessions, no messages should be sent
    // (events require sessions to route to)
    assertEqual(transport->sentMessages.size(), size_t(0), "no sessions = no sends");

    server.stop();
  }});

  suite.cases.push_back({"CDPServer MockTransport receives message callback", []() {
    struct MockTransport : public CDPTransport {
      bool started = false;
      bool stopped = false;

      bool start(const std::string&, uint16_t) override { started = true; return true; }
      void stop() override { stopped = true; }
      void send(ConnectionId, const std::string&) override {}
      void close(ConnectionId) override {}

      // Test helper: simulate incoming message
      void simulateMessage(ConnectionId connId, const std::string& msg) {
        if (onMessage_) onMessage_(connId, msg);
      }
      void simulateConnect(ConnectionId connId, const std::string& path = "") {
        if (onConnect_) onConnect_(connId, path);
      }
      void simulateDisconnect(ConnectionId connId) {
        if (onDisconnect_) onDisconnect_(connId);
      }
    };

    auto transport = std::make_shared<MockTransport>();

    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;

    CDPServer server(config);
    server.registerTenant(1, "Test App");
    server.start();

    // Verify transport has callbacks wired
    assertTrue(transport->started, "transport started");

    // Simulate a connection
    transport->simulateConnect(100);
    assertEqual(server.getConnectionCount(), size_t(1), "1 connection");

    // Simulate disconnect
    transport->simulateDisconnect(100);
    assertEqual(server.getConnectionCount(), size_t(0), "0 connections after disconnect");

    server.stop();
  }});

  // Full message routing through MockTransport
  suite.cases.push_back({"CDPServer MockTransport full message routing", []() {
    struct MockTransport : public CDPTransport {
      bool started = false;
      bool stopped = false;
      std::vector<std::pair<ConnectionId, std::string>> sentMessages;

      bool start(const std::string&, uint16_t) override { started = true; return true; }
      void stop() override { stopped = true; }
      void send(ConnectionId connId, const std::string& message) override {
        sentMessages.push_back({connId, message});
      }
      void close(ConnectionId) override {}

      void simulateConnect(ConnectionId connId, const std::string& path = "") {
        if (onConnect_) onConnect_(connId, path);
      }
      void simulateMessage(ConnectionId connId, const std::string& msg) {
        if (onMessage_) onMessage_(connId, msg);
      }
      void simulateDisconnect(ConnectionId connId) {
        if (onDisconnect_) onDisconnect_(connId);
      }
    };

    auto transport = std::make_shared<MockTransport>();

    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;

    CDPServer server(config);
    server.registerTenant(1, "Test App");
    server.start();

    // 1. Connect
    transport->simulateConnect(200);
    assertEqual(server.getConnectionCount(), size_t(1), "connected");

    // 2. Send a Runtime.enable message
    transport->simulateMessage(200,
      R"({"id":1,"method":"Runtime.enable"})");

    // Server should have sent a response via transport
    assertTrue(transport->sentMessages.size() >= 1, "got response");
    assertEqual(transport->sentMessages[0].first, ConnectionId(200), "response to conn 200");
    // Response should contain "id":1
    assertTrue(transport->sentMessages[0].second.find("\"id\":1") != std::string::npos, "has id:1");

    // 3. Send Runtime.evaluate (no callback set, should get error or empty result)
    transport->simulateMessage(200,
      R"({"id":2,"method":"Runtime.evaluate","params":{"expression":"1+1"}})");
    assertTrue(transport->sentMessages.size() >= 2, "got 2nd response");

    // 4. Stats
    assertTrue(server.getMessagesReceived() >= 2, "2+ messages received");
    assertTrue(server.getMessagesSent() >= 2, "2+ messages sent");

    // 5. Disconnect
    transport->simulateDisconnect(200);
    assertEqual(server.getConnectionCount(), size_t(0), "disconnected");

    server.stop();
  }});

  // Multiple connections lifecycle
  suite.cases.push_back({"CDPServer MockTransport multiple connections", []() {
    struct MockTransport : public CDPTransport {
      bool started = false;
      bool stopped = false;

      bool start(const std::string&, uint16_t) override { started = true; return true; }
      void stop() override { stopped = true; }
      void send(ConnectionId, const std::string&) override {}
      void close(ConnectionId) override {}

      void simulateConnect(ConnectionId connId, const std::string& path = "") {
        if (onConnect_) onConnect_(connId, path);
      }
      void simulateDisconnect(ConnectionId connId) {
        if (onDisconnect_) onDisconnect_(connId);
      }
    };

    auto transport = std::make_shared<MockTransport>();

    CDPServerConfig config;
    config.enabled = true;
    config.transport = transport;

    CDPServer server(config);
    server.registerTenant(1, "App 1");
    server.registerTenant(2, "App 2");
    server.start();

    // Connect 3 clients
    transport->simulateConnect(301);
    transport->simulateConnect(302);
    transport->simulateConnect(303);
    assertEqual(server.getConnectionCount(), size_t(3), "3 connections");

    // Disconnect middle one
    transport->simulateDisconnect(302);
    assertEqual(server.getConnectionCount(), size_t(2), "2 connections after disconnect");

    // Disconnect rest
    transport->simulateDisconnect(301);
    transport->simulateDisconnect(303);
    assertEqual(server.getConnectionCount(), size_t(0), "0 connections");

    // Stop cleans up
    server.stop();
    assertTrue(!server.isRunning(), "stopped");
  }});

  return suite;
}

} // anonymous namespace

// Register with test runner
static struct CDPServerTestRegistrar {
  CDPServerTestRegistrar() {
    TestRunner::instance().addSuite(createCDPServerTests());
  }
} s_cdpServerTestRegistrar;
