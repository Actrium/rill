/**
 * test_adapter_debug_target.cpp
 *
 * Unit tests for AdapterDebugTarget: the raw-CDP <-> method-level bridge over
 * DebuggerAdapter (Phase-2 T2.1, adapter path for agent-less engines).
 */
#include "test_framework.h"
#include "../src/devtools/AdapterDebugTarget.h"
#include "../src/devtools/DebuggerAdapter.h"
#include "../src/devtools/CDPServer.h"

#include <memory>
#include <string>
#include <vector>

using namespace rill::devtools;
using namespace rill::test;

namespace {

// A DebuggerAdapter backed by the built-in StubEngineDebugger, wired to a fresh
// (unstarted) CDPServer — enough to exercise the request->response bridge.
static std::shared_ptr<DebuggerAdapter> makeAdapter(CDPServer& server) {
  auto adapter = std::make_shared<DebuggerAdapter>(server);
  adapter->setEngineDebugger(std::make_shared<StubEngineDebugger>());
  return adapter;
}

TestSuite createAdapterDebugTargetTests() {
  TestSuite suite{"AdapterDebugTarget", {}};

  suite.cases.push_back({"owns the Debugger domain only", []() {
    CDPServer server;
    AdapterDebugTarget target(makeAdapter(server), 1);
    DomainSet d = target.ownedDomains();
    assertTrue(d.owns("Debugger"), "owns Debugger");
    assertFalse(d.owns("Runtime"), "Runtime stays local");
    assertFalse(d.owns("DOM"), "not DOM");
  }});

  suite.cases.push_back({"Debugger.enable -> CDP response echoing the request id", []() {
    CDPServer server;
    AdapterDebugTarget target(makeAdapter(server), 1);
    std::vector<std::string> out;
    target.dispatch(R"({"id":11,"method":"Debugger.enable"})",
                    [&](const RawCdpMessage& m) { out.push_back(m); });
    assertEqual(out.size(), size_t(1), "one response");
    assertTrue(out[0].find("\"id\":11") != std::string::npos, "echoes id 11");
    assertTrue(out[0].find("\"error\"") == std::string::npos, "not an error");
  }});

  suite.cases.push_back({"unknown Debugger method -> METHOD_NOT_FOUND error", []() {
    CDPServer server;
    AdapterDebugTarget target(makeAdapter(server), 1);
    std::vector<std::string> out;
    target.dispatch(R"({"id":12,"method":"Debugger.bogusMethod"})",
                    [&](const RawCdpMessage& m) { out.push_back(m); });
    assertEqual(out.size(), size_t(1), "one message");
    assertTrue(out[0].find("\"error\"") != std::string::npos, "is an error");
    assertTrue(out[0].find("-32601") != std::string::npos, "METHOD_NOT_FOUND code");
  }});

  return suite;
}

}  // anonymous namespace

static struct AdapterDebugTargetRegistrar {
  AdapterDebugTargetRegistrar() {
    TestRunner::instance().addSuite(createAdapterDebugTargetTests());
  }
} s_adapterDebugTargetRegistrar;
