/**
 * test_engine_debug_target.cpp
 *
 * Unit tests for the IEngineDebugTarget relay seam (Phase-2 T2.1).
 */
#include "test_framework.h"
#include "../src/devtools/EngineDebugTarget.h"

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

  void dispatch(const RawCdpMessage& req, const CdpOutboundFn& out) override {
    (void)req;
    out(std::string("{\"id\":1,\"result\":{}}"));
    if (emitEvent) {
      out(std::string("{\"method\":\"Debugger.scriptParsed\",\"params\":{}}"));
    }
  }
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

  suite.cases.push_back({"dispatch emits response + event through the sink", []() {
    FakeAgentTarget t;
    std::vector<std::string> out;
    t.dispatch("{\"id\":1,\"method\":\"Runtime.evaluate\"}",
               [&](const RawCdpMessage& m) { out.push_back(m); });
    assertEqual(out.size(), size_t(2), "response + event");
    assertTrue(out[0].find("\"result\"") != std::string::npos, "first is a response");
    assertTrue(out[1].find("scriptParsed") != std::string::npos, "second is an event");
  }});

  suite.cases.push_back({"a target may emit response only (0 events)", []() {
    FakeAgentTarget t;
    t.emitEvent = false;
    std::vector<std::string> out;
    t.dispatch("{\"id\":2,\"method\":\"Debugger.enable\"}",
               [&](const RawCdpMessage& m) { out.push_back(m); });
    assertEqual(out.size(), size_t(1), "just the response, no events");
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
