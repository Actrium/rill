#include "test_framework.h"
#include "../src/ThreadPool.h"
#include <atomic>
#include <chrono>
#include <thread>

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

// Helper to wait for a condition
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

TestSuite createThreadPoolTests() {
  TestSuite suite{"ThreadPool", {}};

  suite.cases.push_back({"createThread returns valid thread", []() {
    ThreadPool pool;
    auto* thread = pool.createThread(1);
    assertTrue(thread != nullptr, "thread should be created");
    assertTrue(thread->isRunning(), "thread should be running");
  }});

  suite.cases.push_back({"createThread with same ID throws", []() {
    ThreadPool pool;
    pool.createThread(1);
    assertThrows<std::runtime_error>([&pool]() {
      pool.createThread(1);
    }, "duplicate ID should throw");
  }});

  suite.cases.push_back({"getThread returns created thread", []() {
    ThreadPool pool;
    pool.createThread(5);
    auto* t = pool.getThread(5);
    assertTrue(t != nullptr);
    assertEqual<TenantId>(t->id(), 5);
  }});

  suite.cases.push_back({"getThread returns null for unknown", []() {
    ThreadPool pool;
    auto* t = pool.getThread(999);
    assertTrue(t == nullptr);
  }});

  suite.cases.push_back({"destroyThread removes thread", []() {
    ThreadPool pool;
    pool.createThread(1);
    assertTrue(pool.getThread(1) != nullptr);

    pool.destroyThread(1);
    assertTrue(pool.getThread(1) == nullptr);
  }});

  suite.cases.push_back({"destroyThread unknown ID is safe", []() {
    ThreadPool pool;
    pool.destroyThread(999); // should not crash
  }});

  suite.cases.push_back({"activeCount tracks threads", []() {
    ThreadPool pool;
    assertEqual<size_t>(pool.activeThreadCount(), 0);

    pool.createThread(1);
    assertEqual<size_t>(pool.activeThreadCount(), 1);

    pool.createThread(2);
    assertEqual<size_t>(pool.activeThreadCount(), 2);

    pool.destroyThread(1);
    assertEqual<size_t>(pool.activeThreadCount(), 1);
  }});

  suite.cases.push_back({"multiple threads execute independently", []() {
    ThreadPool pool;
    std::atomic<int> count1{0};
    std::atomic<int> count2{0};

    auto* t1 = pool.createThread(1);
    auto* t2 = pool.createThread(2);

    for (int i = 0; i < 5; i++) {
      t1->post([&count1]() { count1.fetch_add(1); });
      t2->post([&count2]() { count2.fetch_add(1); });
    }

    assertTrue(waitFor([&]() { return count1.load() == 5 && count2.load() == 5; }),
               "both threads should complete all tasks");
  }});

  suite.cases.push_back({"max threads limit enforced", []() {
    ThreadPool pool(2); // max 2 threads
    pool.createThread(1);
    pool.createThread(2);

    assertThrows<std::runtime_error>([&pool]() {
      pool.createThread(3);
    }, "should throw when over capacity");

    assertEqual<size_t>(pool.activeThreadCount(), 2);
  }});

  suite.cases.push_back({"destructor cleans up all threads", []() {
    std::atomic<bool> task1Done{false};
    std::atomic<bool> task2Done{false};

    {
      ThreadPool pool;
      auto* t1 = pool.createThread(1);
      auto* t2 = pool.createThread(2);

      t1->post([&task1Done]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        task1Done.store(true);
      });
      t2->post([&task2Done]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        task2Done.store(true);
      });
    }
    // Pool destroyed — threads should have joined
    // Tasks may or may not have completed depending on timing,
    // but no crash should occur
  }});

  suite.cases.push_back({"post and runSync work through pool", []() {
    ThreadPool pool;
    auto* thread = pool.createThread(1);

    int result = thread->runSync<int>([]() -> int { return 123; });
    assertEqual(result, 123);
  }});

  return suite;
}

} // namespace

void registerThreadPoolTests() {
  TestRunner::instance().addSuite(createThreadPoolTests());
}
