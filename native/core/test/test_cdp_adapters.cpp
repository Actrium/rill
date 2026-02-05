/**
 * test_cdp_adapters.cpp
 *
 * P3-Y.T: CDP Domain Adapter Tests
 */

#include "test_framework.h"
#include "../src/devtools/CDPServer.h"
#include "../src/devtools/ConsoleAdapter.h"
#include "../src/devtools/RuntimeAdapter.h"
#include "../src/devtools/DOMAdapter.h"

using namespace rill::devtools;
using namespace rill::test;

namespace {

TestSuite createCDPAdaptersTests() {
  TestSuite suite{"CDPAdapters", {}};

  // ConsoleAdapter Tests
  suite.cases.push_back({"ConsoleAdapter console levels", []() {
    assertEqual(std::string(consoleLevelToCDP(ConsoleLevel::Log)), std::string("log"), "log");
    assertEqual(std::string(consoleLevelToCDP(ConsoleLevel::Debug)), std::string("debug"), "debug");
    assertEqual(std::string(consoleLevelToCDP(ConsoleLevel::Warning)), std::string("warning"), "warning");
    assertEqual(std::string(consoleLevelToCDP(ConsoleLevel::Error)), std::string("error"), "error");
  }});

  suite.cases.push_back({"ConsoleArg helpers", []() {
    auto undef = ConsoleArg::undefined();
    assertEqual(static_cast<int>(undef.type), static_cast<int>(ConsoleArg::Type::Undefined), "undefined");
    
    auto null = ConsoleArg::null();
    assertEqual(static_cast<int>(null.type), static_cast<int>(ConsoleArg::Type::Null), "null");
    
    auto boolTrue = ConsoleArg::boolean(true);
    assertEqual(boolTrue.value, std::string("true"), "bool true");
    
    auto str = ConsoleArg::string("hello");
    assertEqual(str.value, std::string("hello"), "string");
  }});

  suite.cases.push_back({"ConsoleAdapter handleEnable", []() {
    CDPServer server;
    ConsoleAdapter adapter(server);
    auto response = adapter.handleEnable(1, 42);
    
    assertEqual(response.id, 42, "id");
    assertEqual(response.result, std::string("{}"), "result");
    assertTrue(!response.isError(), "no error");
  }});

  // RuntimeAdapter Tests
  suite.cases.push_back({"RuntimeAdapter handleEnable", []() {
    CDPServer server;
    server.registerTenant(1, "Test");
    RuntimeAdapter adapter(server);
    auto response = adapter.handleEnable(1, 1);
    
    assertEqual(response.id, 1, "id");
    assertTrue(!response.isError(), "no error");
  }});

  suite.cases.push_back({"RuntimeAdapter handleEvaluate without callback", []() {
    CDPServer server;
    RuntimeAdapter adapter(server);
    auto response = adapter.handleEvaluate(1, 3, R"({"expression":"1+1"})");
    
    assertEqual(response.id, 3, "id");
    assertTrue(response.result.find("undefined") != std::string::npos, "returns undefined");
  }});

  suite.cases.push_back({"RuntimeAdapter handleEvaluate missing expression", []() {
    CDPServer server;
    RuntimeAdapter adapter(server);
    auto response = adapter.handleEvaluate(1, 4, "{}");
    
    assertEqual(response.id, 4, "id");
    assertTrue(response.isError(), "is error");
  }});

  suite.cases.push_back({"RuntimeAdapter handleGetHeapUsage", []() {
    CDPServer server;
    RuntimeAdapter adapter(server);
    auto response = adapter.handleGetHeapUsage(1, 8);
    
    assertEqual(response.id, 8, "id");
    assertTrue(response.result.find("usedSize") != std::string::npos, "has usedSize");
  }});

  // DOMAdapter Tests
  suite.cases.push_back({"DOMNodeType constants", []() {
    assertEqual(DOMNodeType::ELEMENT_NODE, 1, "element");
    assertEqual(DOMNodeType::TEXT_NODE, 3, "text");
    assertEqual(DOMNodeType::DOCUMENT_NODE, 9, "document");
  }});

  suite.cases.push_back({"DOMAdapter handleEnable", []() {
    CDPServer server;
    DOMAdapter adapter(server);
    auto response = adapter.handleEnable(1, 1);
    
    assertEqual(response.id, 1, "id");
    assertEqual(response.result, std::string("{}"), "result");
  }});

  suite.cases.push_back({"DOMAdapter handleGetDocument without callback", []() {
    CDPServer server;
    DOMAdapter adapter(server);
    auto response = adapter.handleGetDocument(1, 3, "{}");
    
    assertEqual(response.id, 3, "id");
    assertTrue(response.result.find("root") != std::string::npos, "has root");
    assertTrue(response.result.find("#document") != std::string::npos, "has document");
  }});

  suite.cases.push_back({"DOMAdapter handleGetAttributes missing nodeId", []() {
    CDPServer server;
    DOMAdapter adapter(server);
    auto response = adapter.handleGetAttributes(1, 6, "{}");
    
    assertEqual(response.id, 6, "id");
    assertTrue(response.isError(), "is error");
  }});

  // DOMNode Tests
  suite.cases.push_back({"DOMNode default values", []() {
    DOMNode node;
    assertEqual(node.nodeId, 0, "nodeId");
    assertEqual(node.nodeType, DOMNodeType::ELEMENT_NODE, "nodeType");
    assertEqual(node.childNodeCount, 0, "childNodeCount");
  }});

  return suite;
}

} // anonymous namespace

// Register with test runner
static struct CDPAdaptersTestRegistrar {
  CDPAdaptersTestRegistrar() {
    TestRunner::instance().addSuite(createCDPAdaptersTests());
  }
} s_cdpAdaptersTestRegistrar;
