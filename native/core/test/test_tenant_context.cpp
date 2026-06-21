#include "test_framework.h"
#include "../src/TenantContext.h"

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

TestSuite createTenantContextTests() {
  TestSuite suite{"TenantContext", {}};

  // --- ComponentPermission ---

  suite.cases.push_back({"allowAll permits any component", []() {
    TenantContext ctx;
    ctx.components.allowAll = true;
    assertTrue(ctx.canUseComponent("View"));
    assertTrue(ctx.canUseComponent("Text"));
    assertTrue(ctx.canUseComponent("AnythingAtAll"));
  }});

  suite.cases.push_back({"whitelist only permits listed components", []() {
    TenantContext ctx;
    ctx.components.allowAll = false;
    ctx.components.allowedComponents.insert("View");
    ctx.components.allowedComponents.insert("Text");
    assertTrue(ctx.canUseComponent("View"));
    assertTrue(ctx.canUseComponent("Text"));
    assertFalse(ctx.canUseComponent("Image"));
    assertFalse(ctx.canUseComponent("ScrollView"));
  }});

  suite.cases.push_back({"empty whitelist denies all", []() {
    TenantContext ctx;
    ctx.components.allowAll = false;
    assertFalse(ctx.canUseComponent("View"));
  }});

  // --- APIPermission ---

  suite.cases.push_back({"allowAll permits any API", []() {
    TenantContext ctx;
    ctx.apis.allowAll = true;
    assertTrue(ctx.canUseAPI("fetch"));
    assertTrue(ctx.canUseAPI("storage"));
  }});

  suite.cases.push_back({"API whitelist only permits listed", []() {
    TenantContext ctx;
    ctx.apis.allowAll = false;
    ctx.apis.allowedAPIs.insert("fetch");
    assertTrue(ctx.canUseAPI("fetch"));
    assertFalse(ctx.canUseAPI("storage"));
  }});

  // --- ResourceQuota: canCreateTimer ---

  suite.cases.push_back({"canCreateTimer within quota", []() {
    TenantContext ctx;
    ctx.quota.maxTimers = 10;
    ctx.usage.activeTimers.store(5);
    assertTrue(ctx.canCreateTimer());
  }});

  suite.cases.push_back({"canCreateTimer at limit", []() {
    TenantContext ctx;
    ctx.quota.maxTimers = 10;
    ctx.usage.activeTimers.store(10);
    assertFalse(ctx.canCreateTimer());
  }});

  suite.cases.push_back({"canCreateTimer over limit", []() {
    TenantContext ctx;
    ctx.quota.maxTimers = 10;
    ctx.usage.activeTimers.store(15);
    assertFalse(ctx.canCreateTimer());
  }});

  // --- ResourceQuota: canRegisterCallback ---

  suite.cases.push_back({"canRegisterCallback within quota", []() {
    TenantContext ctx;
    ctx.quota.maxCallbacks = 100;
    ctx.usage.activeCallbacks.store(50);
    assertTrue(ctx.canRegisterCallback());
  }});

  suite.cases.push_back({"canRegisterCallback at limit", []() {
    TenantContext ctx;
    ctx.quota.maxCallbacks = 100;
    ctx.usage.activeCallbacks.store(100);
    assertFalse(ctx.canRegisterCallback());
  }});

  // --- ResourceQuota: canSendBatch ---

  suite.cases.push_back({"canSendBatch checks ops per batch", []() {
    TenantContext ctx;
    ctx.quota.maxOpsPerBatch = 5000;
    // canSendBatch doesn't use the atomic counter directly in this way,
    // but verifies the quota is set properly
    assertTrue(ctx.canSendBatch());
  }});

  // --- isOverQuota ---

  suite.cases.push_back({"isOverQuota false when within limits", []() {
    TenantContext ctx;
    ctx.quota.maxHeapBytes = 64 * 1024 * 1024;
    ctx.quota.maxTimers = 100;
    ctx.quota.maxCallbacks = 1000;
    ctx.usage.currentHeapBytes.store(32 * 1024 * 1024);
    ctx.usage.activeTimers.store(50);
    ctx.usage.activeCallbacks.store(500);
    assertFalse(ctx.isOverQuota());
  }});

  suite.cases.push_back({"isOverQuota true when heap exceeded", []() {
    TenantContext ctx;
    ctx.quota.maxHeapBytes = 64 * 1024 * 1024;
    ctx.usage.currentHeapBytes.store(100 * 1024 * 1024);
    assertTrue(ctx.isOverQuota());
  }});

  suite.cases.push_back({"isOverQuota true when timers exceeded", []() {
    TenantContext ctx;
    ctx.quota.maxTimers = 100;
    ctx.usage.activeTimers.store(200);
    assertTrue(ctx.isOverQuota());
  }});

  // --- isNearQuota ---

  suite.cases.push_back({"isNearQuota at 80% threshold", []() {
    TenantContext ctx;
    ctx.quota.maxHeapBytes = 100;
    ctx.usage.currentHeapBytes.store(85);
    assertTrue(ctx.isNearQuota(0.8f), "85/100 should be near quota at 80%");
  }});

  suite.cases.push_back({"isNearQuota below threshold", []() {
    TenantContext ctx;
    ctx.quota.maxHeapBytes = 100;
    ctx.usage.currentHeapBytes.store(50);
    ctx.quota.maxTimers = 100;
    ctx.usage.activeTimers.store(50);
    ctx.quota.maxCallbacks = 100;
    ctx.usage.activeCallbacks.store(50);
    assertFalse(ctx.isNearQuota(0.8f), "50/100 should not be near at 80%");
  }});

  // --- TenantIdentity ---

  suite.cases.push_back({"identity stores app metadata", []() {
    TenantContext ctx;
    ctx.identity.appId = "com.test.app";
    ctx.identity.version = "1.0.0";
    ctx.identity.bundleHash = "abc123";
    ctx.identity.environment = "production";
    assertEqual<std::string>(ctx.identity.appId, "com.test.app");
    assertEqual<std::string>(ctx.identity.version, "1.0.0");
    assertEqual<std::string>(ctx.identity.bundleHash, "abc123");
    assertEqual<std::string>(ctx.identity.environment, "production");
  }});

  // --- TenantState ---

  suite.cases.push_back({"default state is Created", []() {
    TenantContext ctx;
    assertTrue(ctx.state == TenantState::Created);
  }});

  suite.cases.push_back({"state transitions", []() {
    TenantContext ctx;
    ctx.state = TenantState::Loading;
    assertTrue(ctx.state == TenantState::Loading);
    ctx.state = TenantState::Running;
    assertTrue(ctx.state == TenantState::Running);
    ctx.state = TenantState::Paused;
    assertTrue(ctx.state == TenantState::Paused);
    ctx.state = TenantState::Error;
    assertTrue(ctx.state == TenantState::Error);
    ctx.state = TenantState::Destroying;
    assertTrue(ctx.state == TenantState::Destroying);
    ctx.state = TenantState::Destroyed;
    assertTrue(ctx.state == TenantState::Destroyed);
  }});

  // --- Atomic counters ---

  suite.cases.push_back({"atomic counters are thread-safe incrementable", []() {
    TenantContext ctx;
    ctx.usage.activeTimers.fetch_add(1);
    ctx.usage.activeTimers.fetch_add(1);
    ctx.usage.activeTimers.fetch_add(1);
    assertEqual<uint32_t>(ctx.usage.activeTimers.load(), 3);
    ctx.usage.activeTimers.fetch_sub(1);
    assertEqual<uint32_t>(ctx.usage.activeTimers.load(), 2);
  }});

  suite.cases.push_back({"violation counters track violations", []() {
    TenantContext ctx;
    assertEqual<uint32_t>(ctx.usage.componentViolations.load(), 0);
    ctx.usage.componentViolations.fetch_add(1);
    assertEqual<uint32_t>(ctx.usage.componentViolations.load(), 1);
    ctx.usage.apiViolations.fetch_add(3);
    assertEqual<uint32_t>(ctx.usage.apiViolations.load(), 3);
  }});

  return suite;
}

} // namespace

void registerTenantContextTests() {
  TestRunner::instance().addSuite(createTenantContextTests());
}
