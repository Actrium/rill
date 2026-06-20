#include "test_framework.h"
#include "../src/TenantRegistry.h"

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

TestSuite createTenantRegistryTests() {
  TestSuite suite{"TenantRegistry", {}};

  suite.cases.push_back({"registerTenant returns incrementing IDs", []() {
    TenantRegistry reg;
    TenantIdentity id1;
    id1.appId = "app1";
    auto tid1 = reg.registerTenant(id1, {}, {}, {});

    TenantIdentity id2;
    id2.appId = "app2";
    auto tid2 = reg.registerTenant(id2, {}, {}, {});

    assertTrue(tid2 > tid1, "IDs should increment");
  }});

  suite.cases.push_back({"getContext returns registered tenant", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "com.test";
    auto tid = reg.registerTenant(id, {}, {}, {});

    auto* ctx = reg.getContext(tid);
    assertTrue(ctx != nullptr, "context should exist");
    assertEqual<std::string>(ctx->identity.appId, "com.test");
  }});

  suite.cases.push_back({"getContext returns null for unknown ID", []() {
    TenantRegistry reg;
    auto* ctx = reg.getContext(999);
    assertTrue(ctx == nullptr, "should be null");
  }});

  suite.cases.push_back({"getContextByAppId returns tenant", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "com.lookup";
    reg.registerTenant(id, {}, {}, {});

    auto* ctx = reg.getContextByAppId("com.lookup");
    assertTrue(ctx != nullptr);
    assertEqual<std::string>(ctx->identity.appId, "com.lookup");
  }});

  suite.cases.push_back({"getContextByAppId returns null for unknown", []() {
    TenantRegistry reg;
    auto* ctx = reg.getContextByAppId("nonexistent");
    assertTrue(ctx == nullptr);
  }});

  suite.cases.push_back({"unregisterTenant removes tenant", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "to-remove";
    auto tid = reg.registerTenant(id, {}, {}, {});

    assertEqual<size_t>(reg.totalTenants(), 1);
    reg.unregisterTenant(tid);
    assertEqual<size_t>(reg.totalTenants(), 0);
    assertTrue(reg.getContext(tid) == nullptr);
  }});

  suite.cases.push_back({"unregisterTenant unknown ID is safe", []() {
    TenantRegistry reg;
    reg.unregisterTenant(999); // should not crash
  }});

  suite.cases.push_back({"double unregister is safe", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "double-remove";
    auto tid = reg.registerTenant(id, {}, {}, {});
    reg.unregisterTenant(tid);
    reg.unregisterTenant(tid); // should not crash
  }});

  suite.cases.push_back({"totalTenants tracks count", []() {
    TenantRegistry reg;
    assertEqual<size_t>(reg.totalTenants(), 0);

    TenantIdentity id1;
    id1.appId = "a1";
    reg.registerTenant(id1, {}, {}, {});
    assertEqual<size_t>(reg.totalTenants(), 1);

    TenantIdentity id2;
    id2.appId = "a2";
    reg.registerTenant(id2, {}, {}, {});
    assertEqual<size_t>(reg.totalTenants(), 2);
  }});

  suite.cases.push_back({"getActiveTenants excludes destroyed", []() {
    TenantRegistry reg;
    TenantIdentity id1;
    id1.appId = "active";
    auto tid1 = reg.registerTenant(id1, {}, {}, {});

    TenantIdentity id2;
    id2.appId = "will-destroy";
    auto tid2 = reg.registerTenant(id2, {}, {}, {});

    auto active = reg.getActiveTenants();
    assertEqual<size_t>(active.size(), 2);

    // Destroy one
    reg.unregisterTenant(tid2);
    active = reg.getActiveTenants();
    assertEqual<size_t>(active.size(), 1);
    assertEqual(active[0], tid1);
  }});

  suite.cases.push_back({"getTenantsByAppId returns multiple", []() {
    TenantRegistry reg;
    // Same appId, multiple instances
    TenantIdentity id1;
    id1.appId = "shared-app";
    reg.registerTenant(id1, {}, {}, {});

    TenantIdentity id2;
    id2.appId = "shared-app";
    reg.registerTenant(id2, {}, {}, {});

    TenantIdentity id3;
    id3.appId = "other-app";
    reg.registerTenant(id3, {}, {}, {});

    auto shared = reg.getTenantsByAppId("shared-app");
    assertEqual<size_t>(shared.size(), 2);

    auto other = reg.getTenantsByAppId("other-app");
    assertEqual<size_t>(other.size(), 1);
  }});

  suite.cases.push_back({"updateQuota modifies tenant quota", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "quota-test";
    ResourceQuota initial;
    initial.maxTimers = 100;
    auto tid = reg.registerTenant(id, {}, {}, initial);

    auto* ctx = reg.getContext(tid);
    assertEqual<uint32_t>(ctx->quota.maxTimers, 100);

    ResourceQuota updated;
    updated.maxTimers = 200;
    reg.updateQuota(tid, updated);

    ctx = reg.getContext(tid);
    assertEqual<uint32_t>(ctx->quota.maxTimers, 200);
  }});

  suite.cases.push_back({"updateQuota on unknown ID is safe", []() {
    TenantRegistry reg;
    ResourceQuota q;
    reg.updateQuota(999, q); // should not crash
  }});

  suite.cases.push_back({"activeTenants count", []() {
    TenantRegistry reg;
    assertEqual<size_t>(reg.activeTenants(), 0);

    TenantIdentity id1;
    id1.appId = "a1";
    reg.registerTenant(id1, {}, {}, {});
    assertEqual<size_t>(reg.activeTenants(), 1);

    TenantIdentity id2;
    id2.appId = "a2";
    auto tid2 = reg.registerTenant(id2, {}, {}, {});
    assertEqual<size_t>(reg.activeTenants(), 2);

    reg.unregisterTenant(tid2);
    assertEqual<size_t>(reg.activeTenants(), 1);
  }});

  suite.cases.push_back({"permissions are stored on context", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "perm-test";

    ComponentPermission cp;
    cp.allowAll = false;
    cp.allowedComponents.insert("View");

    APIPermission ap;
    ap.allowAll = false;
    ap.allowedAPIs.insert("fetch");

    auto tid = reg.registerTenant(id, cp, ap, {});
    auto* ctx = reg.getContext(tid);

    assertTrue(ctx->canUseComponent("View"), "View allowed");
    assertFalse(ctx->canUseComponent("Image"), "Image not allowed");
    assertTrue(ctx->canUseAPI("fetch"), "fetch allowed");
    assertFalse(ctx->canUseAPI("storage"), "storage not allowed");
  }});

  suite.cases.push_back({"timestamps are set on registration", []() {
    TenantRegistry reg;
    TenantIdentity id;
    id.appId = "ts-test";
    auto tid = reg.registerTenant(id, {}, {}, {});

    auto* ctx = reg.getContext(tid);
    assertGreater(ctx->createdAt, 0.0, "createdAt should be set");
    assertGreater(ctx->lastActivityAt, 0.0, "lastActivityAt should be set");
    assertApprox(ctx->createdAt, ctx->lastActivityAt, 1.0,
                 "createdAt ~= lastActivityAt");
  }});

  return suite;
}

} // namespace

void registerTenantRegistryTests() {
  TestRunner::instance().addSuite(createTenantRegistryTests());
}
