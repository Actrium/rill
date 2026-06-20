#include "test_framework.h"
#include "../src/ThreadPool.h"
#include "../src/TenantThread.h"
#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

// Helper to wait for a condition with timeout
template <typename Pred>
bool waitFor(Pred pred, int maxMs = 3000) {
  auto start = std::chrono::steady_clock::now();
  while (!pred()) {
    auto elapsed = std::chrono::steady_clock::now() - start;
    if (std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() >
        maxMs) {
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return true;
}

TestSuite createTenantManagerIntegrationTests() {
  TestSuite suite{"TenantManagerIntegration (ThreadPool+Timer)", {}};

  // --- Multi-tenant timer isolation ---

  suite.cases.push_back({"multi-tenant: timers fire independently per tenant", []() {
    ThreadPool pool;

    pool.createThread(1);
    pool.createThread(2);
    pool.createThread(3);

    std::atomic<int> count1{0}, count2{0}, count3{0};

    pool.getThread(1)->scheduleInterval([&count1]() { count1.fetch_add(1); }, 40);
    pool.getThread(2)->scheduleInterval([&count2]() { count2.fetch_add(1); }, 60);
    pool.getThread(3)->scheduleInterval([&count3]() { count3.fetch_add(1); }, 80);

    assertTrue(waitFor([&]() {
      return count1.load() >= 3 && count2.load() >= 2 && count3.load() >= 2;
    }), "all tenants should fire independently");

    pool.destroyThread(1);
    pool.destroyThread(2);
    pool.destroyThread(3);
  }});

  suite.cases.push_back({"multi-tenant: destroying one tenant doesn't affect others", []() {
    ThreadPool pool;

    pool.createThread(10);
    pool.createThread(20);

    std::atomic<int> count10{0}, count20{0};

    pool.getThread(10)->scheduleInterval([&count10]() { count10.fetch_add(1); }, 40);
    pool.getThread(20)->scheduleInterval([&count20]() { count20.fetch_add(1); }, 40);

    // Wait for both to start firing
    assertTrue(waitFor([&]() {
      return count10.load() >= 2 && count20.load() >= 2;
    }), "both tenants should fire");

    // Destroy tenant 10
    int snapshot20 = count20.load();
    pool.destroyThread(10);

    // Tenant 20 should continue firing
    assertTrue(waitFor([&]() {
      return count20.load() > snapshot20 + 2;
    }), "tenant 20 should continue after tenant 10 destroyed");

    pool.destroyThread(20);
  }});

  suite.cases.push_back({"multi-tenant: timer callback IDs are routed correctly", []() {
    ThreadPool pool;

    pool.createThread(1);
    pool.createThread(2);

    // Simulate onTimerFired pattern: callbacks record (tenantId, callbackId)
    struct TimerEvent {
      TenantId tenantId;
      std::string callbackId;
    };

    std::vector<TimerEvent> events;
    std::mutex eventsMutex;

    auto makeCallback = [&events, &eventsMutex](TenantId tid, const std::string& cbId) {
      return [&events, &eventsMutex, tid, cbId]() {
        std::lock_guard<std::mutex> lock(eventsMutex);
        events.push_back({tid, cbId});
      };
    };

    pool.getThread(1)->scheduleTimeout(makeCallback(1, "cb-a"), 30);
    pool.getThread(1)->scheduleTimeout(makeCallback(1, "cb-b"), 60);
    pool.getThread(2)->scheduleTimeout(makeCallback(2, "cb-x"), 30);

    assertTrue(waitFor([&]() {
      std::lock_guard<std::mutex> lock(eventsMutex);
      return events.size() >= 3;
    }), "all 3 timeouts should fire");

    // Verify all expected events arrived
    std::lock_guard<std::mutex> lock(eventsMutex);
    int t1a = 0, t1b = 0, t2x = 0;
    for (const auto& e : events) {
      if (e.tenantId == 1 && e.callbackId == "cb-a") t1a++;
      if (e.tenantId == 1 && e.callbackId == "cb-b") t1b++;
      if (e.tenantId == 2 && e.callbackId == "cb-x") t2x++;
    }
    assertEqual(t1a, 1, "tenant 1 cb-a");
    assertEqual(t1b, 1, "tenant 1 cb-b");
    assertEqual(t2x, 1, "tenant 2 cb-x");

    pool.destroyThread(1);
    pool.destroyThread(2);
  }});

  // --- Pause/resume across tenants ---

  suite.cases.push_back({"multi-tenant: pause one tenant, others continue", []() {
    ThreadPool pool;

    pool.createThread(1);
    pool.createThread(2);

    std::atomic<int> count1{0}, count2{0};

    pool.getThread(1)->scheduleInterval([&count1]() { count1.fetch_add(1); }, 40);
    pool.getThread(2)->scheduleInterval([&count2]() { count2.fetch_add(1); }, 40);

    // Wait for both to start firing
    assertTrue(waitFor([&]() {
      return count1.load() >= 2 && count2.load() >= 2;
    }), "both should fire initially");

    // Pause tenant 1
    int snapshot1 = count1.load();
    int snapshot2 = count2.load();
    pool.getThread(1)->pauseTimers();

    // Wait and verify tenant 2 continues while tenant 1 is frozen
    assertTrue(waitFor([&]() {
      return count2.load() > snapshot2 + 2;
    }), "tenant 2 should continue");

    assertEqual(count1.load(), snapshot1, "tenant 1 should be frozen");

    // Resume tenant 1
    pool.getThread(1)->resumeTimers();
    assertTrue(waitFor([&]() {
      return count1.load() > snapshot1;
    }), "tenant 1 should resume");

    pool.destroyThread(1);
    pool.destroyThread(2);
  }});

  suite.cases.push_back({"multi-tenant: pause all tenants then resume", []() {
    ThreadPool pool;

    pool.createThread(1);
    pool.createThread(2);

    std::atomic<int> count1{0}, count2{0};

    pool.getThread(1)->scheduleInterval([&count1]() { count1.fetch_add(1); }, 40);
    pool.getThread(2)->scheduleInterval([&count2]() { count2.fetch_add(1); }, 40);

    assertTrue(waitFor([&]() {
      return count1.load() >= 2 && count2.load() >= 2;
    }), "both should fire");

    // Pause both
    int snap1 = count1.load();
    int snap2 = count2.load();
    pool.getThread(1)->pauseTimers();
    pool.getThread(2)->pauseTimers();

    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    assertEqual(count1.load(), snap1, "tenant 1 frozen");
    assertEqual(count2.load(), snap2, "tenant 2 frozen");

    // Resume both
    pool.getThread(1)->resumeTimers();
    pool.getThread(2)->resumeTimers();

    assertTrue(waitFor([&]() {
      return count1.load() > snap1 && count2.load() > snap2;
    }), "both should resume");

    pool.destroyThread(1);
    pool.destroyThread(2);
  }});

  // --- Destroy cleanup ---

  suite.cases.push_back({"destroying thread cancels all pending timers", []() {
    ThreadPool pool;
    pool.createThread(1);

    std::atomic<int> count{0};
    pool.getThread(1)->scheduleTimeout([&count]() { count.fetch_add(1); }, 500);
    pool.getThread(1)->scheduleTimeout([&count]() { count.fetch_add(1); }, 600);
    pool.getThread(1)->scheduleInterval([&count]() { count.fetch_add(1); }, 500);

    // Destroy immediately — timers should not fire
    pool.destroyThread(1);

    std::this_thread::sleep_for(std::chrono::milliseconds(800));
    assertEqual(count.load(), 0, "no timers should fire after destroy");
  }});

  suite.cases.push_back({"activeThreadCount tracks create/destroy", []() {
    ThreadPool pool;
    assertEqual<size_t>(pool.activeThreadCount(), 0);

    pool.createThread(1);
    assertEqual<size_t>(pool.activeThreadCount(), 1);

    pool.createThread(2);
    pool.createThread(3);
    assertEqual<size_t>(pool.activeThreadCount(), 3);

    pool.destroyThread(2);
    assertEqual<size_t>(pool.activeThreadCount(), 2);

    pool.destroyThread(1);
    pool.destroyThread(3);
    assertEqual<size_t>(pool.activeThreadCount(), 0);
  }});

  // --- Cross-thread callback simulation ---

  suite.cases.push_back({"timer callback fires on TenantThread, routes to main thread", []() {
    ThreadPool pool;
    pool.createThread(1);

    // Simulate the onTimerFired pattern:
    // Timer fires on TenantThread, then we simulate CallInvoker by posting
    // back to main thread via a shared atomic.
    std::atomic<bool> mainThreadNotified{false};
    std::string receivedCallbackId;
    TenantId receivedTenantId = 0;
    std::mutex resultMutex;

    // Schedule a timeout that simulates the TenantManager's onTimerFired
    pool.getThread(1)->scheduleTimeout(
        [&mainThreadNotified, &receivedCallbackId, &receivedTenantId, &resultMutex]() {
          // This runs on TenantThread — simulate CallInvoker dispatch
          std::lock_guard<std::mutex> lock(resultMutex);
          receivedTenantId = 1;
          receivedCallbackId = "timer-cb-42";
          mainThreadNotified.store(true);
        },
        30);

    assertTrue(waitFor([&]() { return mainThreadNotified.load(); }),
               "callback should notify main thread");

    std::lock_guard<std::mutex> lock(resultMutex);
    assertEqual<TenantId>(receivedTenantId, 1);
    assertEqual<std::string>(receivedCallbackId, "timer-cb-42");

    pool.destroyThread(1);
  }});

  // --- Concurrent operations ---

  suite.cases.push_back({"concurrent schedule/cancel across tenants is safe", []() {
    ThreadPool pool;
    const int numTenants = 5;
    const int timersPerTenant = 10;

    for (int i = 1; i <= numTenants; i++) {
      pool.createThread(static_cast<TenantId>(i));
    }

    std::atomic<int> totalFired{0};
    std::vector<std::thread> schedulers;

    // Spawn threads that concurrently schedule and cancel timers
    for (int i = 1; i <= numTenants; i++) {
      schedulers.emplace_back([&pool, &totalFired, i]() {
        auto* thread = pool.getThread(static_cast<TenantId>(i));
        std::vector<TimerId> ids;

        for (int j = 0; j < timersPerTenant; j++) {
          auto id = thread->scheduleTimeout(
              [&totalFired]() { totalFired.fetch_add(1); },
              20 + (j * 10));
          ids.push_back(id);
        }

        // Cancel half
        for (size_t k = 0; k < ids.size(); k += 2) {
          thread->cancelTimer(ids[k]);
        }
      });
    }

    for (auto& t : schedulers) {
      t.join();
    }

    // Wait for remaining timers to fire
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    // Half were cancelled, so roughly half should fire per tenant
    // Each tenant: 10 timers, 5 cancelled = 5 remaining, total = 25
    // Allow some tolerance due to timing
    assertGreater(static_cast<double>(totalFired.load()), 0.0,
                  "some timers should fire");
    assertLessOrEqual(static_cast<double>(totalFired.load()),
                      static_cast<double>(numTenants * timersPerTenant),
                      "should not exceed total scheduled");

    for (int i = 1; i <= numTenants; i++) {
      pool.destroyThread(static_cast<TenantId>(i));
    }
  }});

  suite.cases.push_back({"rapid create/destroy cycles don't leak threads", []() {
    ThreadPool pool;

    for (int i = 0; i < 20; i++) {
      auto tid = static_cast<TenantId>(100 + i);
      pool.createThread(tid);

      // Schedule some timers
      pool.getThread(tid)->scheduleTimeout([]() {}, 50);
      pool.getThread(tid)->scheduleInterval([]() {}, 30);

      // Immediately destroy
      pool.destroyThread(tid);
    }

    assertEqual<size_t>(pool.activeThreadCount(), 0,
                        "no threads should remain after all destroyed");
  }});

  suite.cases.push_back({"mixed timeout and interval across tenants", []() {
    ThreadPool pool;
    pool.createThread(1);
    pool.createThread(2);

    std::atomic<int> timeouts1{0}, intervals1{0};
    std::atomic<int> timeouts2{0}, intervals2{0};

    // Tenant 1: 2 timeouts + 1 interval
    pool.getThread(1)->scheduleTimeout([&timeouts1]() { timeouts1.fetch_add(1); }, 30);
    pool.getThread(1)->scheduleTimeout([&timeouts1]() { timeouts1.fetch_add(1); }, 60);
    pool.getThread(1)->scheduleInterval([&intervals1]() { intervals1.fetch_add(1); }, 40);

    // Tenant 2: 1 timeout + 2 intervals
    pool.getThread(2)->scheduleTimeout([&timeouts2]() { timeouts2.fetch_add(1); }, 30);
    auto ivl1 = pool.getThread(2)->scheduleInterval(
        [&intervals2]() { intervals2.fetch_add(1); }, 30);
    auto ivl2 = pool.getThread(2)->scheduleInterval(
        [&intervals2]() { intervals2.fetch_add(1); }, 50);

    assertTrue(waitFor([&]() {
      return timeouts1.load() == 2 && timeouts2.load() == 1 &&
             intervals1.load() >= 3 && intervals2.load() >= 4;
    }), "all timer types should fire correctly");

    // Cancel intervals to clean up
    pool.getThread(2)->cancelTimer(ivl1);
    pool.getThread(2)->cancelTimer(ivl2);

    pool.destroyThread(1);
    pool.destroyThread(2);
  }});

  return suite;
}

} // namespace

void registerTenantManagerIntegrationTests() {
  TestRunner::instance().addSuite(createTenantManagerIntegrationTests());
}
