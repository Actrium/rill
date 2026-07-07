#include "test_framework.h"

// Test registration functions (defined in each test file)
void registerTimerWheelTests();
void registerTenantContextTests();
void registerTenantRegistryTests();
void registerTenantThreadTests();
void registerThreadPoolTests();
void registerTenantManagerIntegrationTests();
void registerNetworkSandboxTests();
void registerFileSandboxTests();
void registerEventBusTests();
void registerWireDecoderTests();

int main() {
  std::cout << "==========================================" << std::endl;
  std::cout << "Rill Core C++ Test Suite" << std::endl;
  std::cout << "==========================================" << std::endl;

  // Register all test suites
  registerTimerWheelTests();
  registerTenantContextTests();
  registerTenantRegistryTests();
  registerTenantThreadTests();
  registerThreadPoolTests();
  registerTenantManagerIntegrationTests();
  registerNetworkSandboxTests();
  registerFileSandboxTests();
  registerEventBusTests();
  registerWireDecoderTests();

  // Run all tests
  return rill::test::TestRunner::instance().run();
}
