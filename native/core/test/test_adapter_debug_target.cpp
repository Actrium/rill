/**
 * test_adapter_debug_target.cpp
 *
 * Unit tests for AdapterDebugTarget: the raw-CDP <-> method-level bridge over
 * DebuggerAdapter (Phase-2 T2.1, adapter path for agent-less engines). Covers
 * both the request->response path and the async event path (events broadcast
 * through the per-connection persistent sinks).
 */
#include "test_framework.h"
#include "../src/devtools/AdapterDebugTarget.h"
#include "../src/devtools/DebuggerAdapter.h"

#include <memory>
#include <string>
#include <vector>

using namespace rill::devtools;
using namespace rill::test;

namespace {

// A DebuggerAdapter backed by the built-in StubEngineDebugger — enough to
// exercise the request->response bridge and the event broadcast path.
static std::shared_ptr<DebuggerAdapter> makeAdapter() {
  auto adapter = std::make_shared<DebuggerAdapter>();
  adapter->setEngineDebugger(std::make_shared<StubEngineDebugger>());
  return adapter;
}

TestSuite createAdapterDebugTargetTests() {
  TestSuite suite{"AdapterDebugTarget", {}};

  suite.cases.push_back({"owns the Debugger domain only", []() {
    AdapterDebugTarget target(makeAdapter(), 1);
    DomainSet d = target.ownedDomains();
    assertTrue(d.owns("Debugger"), "owns Debugger");
    assertFalse(d.owns("Runtime"), "Runtime stays local");
    assertFalse(d.owns("DOM"), "not DOM");
  }});

  suite.cases.push_back({"Debugger.enable -> CDP response echoing the request id", []() {
    AdapterDebugTarget target(makeAdapter(), 1);
    std::vector<std::string> out;
    target.onClientConnect(1, [&](const RawCdpMessage& m) { out.push_back(m); });
    target.dispatch(1, R"({"id":11,"method":"Debugger.enable"})");
    assertEqual(out.size(), size_t(1), "one response");
    assertTrue(out[0].find("\"id\":11") != std::string::npos, "echoes id 11");
    assertTrue(out[0].find("\"error\"") == std::string::npos, "not an error");
  }});

  suite.cases.push_back({"unknown Debugger method -> METHOD_NOT_FOUND error", []() {
    AdapterDebugTarget target(makeAdapter(), 1);
    std::vector<std::string> out;
    target.onClientConnect(1, [&](const RawCdpMessage& m) { out.push_back(m); });
    target.dispatch(1, R"({"id":12,"method":"Debugger.bogusMethod"})");
    assertEqual(out.size(), size_t(1), "one message");
    assertTrue(out[0].find("\"error\"") != std::string::npos, "is an error");
    assertTrue(out[0].find("-32601") != std::string::npos, "METHOD_NOT_FOUND code");
  }});

  suite.cases.push_back({"Debugger.paused event broadcasts to every connected sink", []() {
    auto adapter = makeAdapter();
    AdapterDebugTarget target(adapter, 1);
    std::vector<std::string> a, b;
    target.onClientConnect(1, [&](const RawCdpMessage& m) { a.push_back(m); });
    target.onClientConnect(2, [&](const RawCdpMessage& m) { b.push_back(m); });

    // An engine-side pause routes through the adapter's event sink.
    adapter->onPaused(1, PauseReason::Breakpoint, {}, {});

    assertEqual(a.size(), size_t(1), "connection 1 got the event");
    assertEqual(b.size(), size_t(1), "connection 2 got the event");
    assertTrue(a[0].find("\"Debugger.paused\"") != std::string::npos, "is Debugger.paused");
    assertTrue(a[0].find("\"id\"") == std::string::npos, "an event, not a response");
  }});

  suite.cases.push_back({"events stop after disconnect", []() {
    auto adapter = makeAdapter();
    AdapterDebugTarget target(adapter, 1);
    std::vector<std::string> out;
    target.onClientConnect(1, [&](const RawCdpMessage& m) { out.push_back(m); });
    target.onClientDisconnect(1);
    adapter->onResumed(1);
    assertEqual(out.size(), size_t(0), "no event after the sink was removed");
  }});

  return suite;
}

}  // anonymous namespace

static struct AdapterDebugTargetRegistrar {
  AdapterDebugTargetRegistrar() {
    TestRunner::instance().addSuite(createAdapterDebugTargetTests());
  }
} s_adapterDebugTargetRegistrar;
