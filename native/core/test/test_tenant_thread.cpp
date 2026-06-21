#include "test_framework.h"
#include "../src/TenantThread.h"
#include <atomic>
#include <chrono>
#include <thread>

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

// Helper to wait for a condition with timeout
template <typename Pred>
bool waitFor(Pred pred, int maxMs = 2000) {
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

TestSuite createTenantThreadTests() {
  TestSuite suite{"TenantThread", {}};

  suite.cases.push_back({"thread starts and runs", []() {
    TenantThread thread(1);
    assertTrue(thread.isRunning(), "thread should be running");
  }});

  suite.cases.push_back({"post executes task", []() {
    TenantThread thread(1);
    std::atomic<bool> executed{false};

    thread.post([&executed]() { executed.store(true); });

    assertTrue(waitFor([&]() { return executed.load(); }),
               "task should execute");
  }});

  suite.cases.push_back({"post multiple tasks execute in order", []() {
    TenantThread thread(1);
    std::vector<int> order;
    std::mutex orderMutex;
    std::atomic<int> count{0};

    for (int i = 0; i < 10; i++) {
      thread.post([&order, &orderMutex, &count, i]() {
        std::lock_guard<std::mutex> lock(orderMutex);
        order.push_back(i);
        count.fetch_add(1);
      }, TaskPriority::Normal);
    }

    assertTrue(waitFor([&]() { return count.load() == 10; }),
               "all 10 tasks should execute");

    std::lock_guard<std::mutex> lock(orderMutex);
    for (int i = 0; i < 10; i++) {
      assertEqual(order[i], i, "FIFO order for same priority");
    }
  }});

  suite.cases.push_back({"priority ordering: Immediate before Normal", []() {
    TenantThread thread(1);

    // Block the thread first
    std::atomic<bool> gate{false};
    std::atomic<bool> gateReached{false};
    thread.post([&gate, &gateReached]() {
      gateReached.store(true);
      while (!gate.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    });

    // Wait for gate task to start
    assertTrue(waitFor([&]() { return gateReached.load(); }),
               "gate should be reached");

    // Queue tasks with different priorities while thread is blocked
    std::vector<int> order;
    std::mutex orderMutex;
    std::atomic<int> count{0};

    thread.post([&order, &orderMutex, &count]() {
      std::lock_guard<std::mutex> lock(orderMutex);
      order.push_back(3); // Low
      count.fetch_add(1);
    }, TaskPriority::Low);

    thread.post([&order, &orderMutex, &count]() {
      std::lock_guard<std::mutex> lock(orderMutex);
      order.push_back(2); // Normal
      count.fetch_add(1);
    }, TaskPriority::Normal);

    thread.post([&order, &orderMutex, &count]() {
      std::lock_guard<std::mutex> lock(orderMutex);
      order.push_back(0); // Immediate
      count.fetch_add(1);
    }, TaskPriority::Immediate);

    thread.post([&order, &orderMutex, &count]() {
      std::lock_guard<std::mutex> lock(orderMutex);
      order.push_back(1); // High
      count.fetch_add(1);
    }, TaskPriority::High);

    // Release the gate
    gate.store(true);

    assertTrue(waitFor([&]() { return count.load() == 4; }),
               "all 4 tasks should execute");

    std::lock_guard<std::mutex> lock(orderMutex);
    assertEqual<size_t>(order.size(), 4);
    assertEqual(order[0], 0, "Immediate first");
    assertEqual(order[1], 1, "High second");
    assertEqual(order[2], 2, "Normal third");
    assertEqual(order[3], 3, "Low last");
  }});

  suite.cases.push_back({"runSync returns value", []() {
    TenantThread thread(1);

    int result = thread.runSync<int>([]() -> int { return 42; });
    assertEqual(result, 42);
  }});

  suite.cases.push_back({"runSync propagates exception", []() {
    TenantThread thread(1);

    assertThrows<std::runtime_error>([&thread]() {
      thread.runSync<int>([]() -> int {
        throw std::runtime_error("test error");
      });
    });
  }});

  suite.cases.push_back({"requestStop stops the thread", []() {
    auto thread = std::make_unique<TenantThread>(1);
    assertTrue(thread->isRunning());

    thread->requestStop();

    // Destructor joins; after that isRunning should be false
    assertTrue(waitFor([&]() { return !thread->isRunning(); }),
               "thread should stop");
  }});

  suite.cases.push_back({"destructor joins cleanly", []() {
    std::atomic<bool> executed{false};
    {
      TenantThread thread(1);
      thread.post([&executed]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        executed.store(true);
      });
    }
    // After destructor, task should have completed
    assertTrue(executed.load(), "task should complete before destructor returns");
  }});

  suite.cases.push_back({"id returns correct tenant ID", []() {
    TenantThread thread(42);
    assertEqual<TenantId>(thread.id(), 42);
  }});

  // --- Timer integration ---

  suite.cases.push_back({"scheduleTimeout fires callback", []() {
    TenantThread thread(1);
    std::atomic<bool> fired{false};

    thread.scheduleTimeout([&fired]() { fired.store(true); }, 50);

    assertTrue(waitFor([&]() { return fired.load(); }, 3000),
               "timeout should fire");
  }});

  suite.cases.push_back({"scheduleInterval fires multiple times", []() {
    TenantThread thread(1);
    std::atomic<int> count{0};

    auto id = thread.scheduleInterval([&count]() { count.fetch_add(1); }, 50);

    assertTrue(waitFor([&]() { return count.load() >= 3; }, 3000),
               "interval should fire at least 3 times");

    thread.cancelTimer(id);
  }});

  suite.cases.push_back({"cancelTimer stops timeout", []() {
    TenantThread thread(1);
    std::atomic<bool> fired{false};

    auto id = thread.scheduleTimeout([&fired]() { fired.store(true); }, 200);
    thread.cancelTimer(id);

    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    assertFalse(fired.load(), "cancelled timeout should not fire");
  }});

  suite.cases.push_back({"pauseTimers freezes timers", []() {
    TenantThread thread(1);
    std::atomic<int> count{0};

    thread.scheduleInterval([&count]() { count.fetch_add(1); }, 50);

    // Let it fire a couple of times
    assertTrue(waitFor([&]() { return count.load() >= 2; }, 3000),
               "should fire initially");

    int snapshot = count.load();
    thread.pauseTimers();

    // Wait and verify no more fires
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    assertEqual(count.load(), snapshot, "no fires while paused");

    // Resume and verify fires again
    thread.resumeTimers();
    assertTrue(waitFor([&]() { return count.load() > snapshot; }, 3000),
               "should fire after resume");
  }});

  return suite;
}

} // namespace

void registerTenantThreadTests() {
  TestRunner::instance().addSuite(createTenantThreadTests());
}
