#include "test_framework.h"
#include "../src/TimerWheel.h"

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

TestSuite createTimerWheelTests() {
  TestSuite suite{"TimerWheel", {}};

  suite.cases.push_back({"addTimeout returns unique IDs", []() {
    TimerWheel wheel;
    auto id1 = wheel.addTimeout([](){}, 100);
    auto id2 = wheel.addTimeout([](){}, 200);
    auto id3 = wheel.addTimeout([](){}, 300);
    assertTrue(id1 != id2, "id1 != id2");
    assertTrue(id2 != id3, "id2 != id3");
    assertTrue(id1 != id3, "id1 != id3");
  }});

  suite.cases.push_back({"addInterval returns unique IDs", []() {
    TimerWheel wheel;
    auto id1 = wheel.addInterval([](){}, 100);
    auto id2 = wheel.addInterval([](){}, 200);
    assertTrue(id1 != id2, "id1 != id2");
  }});

  suite.cases.push_back({"activeCount tracks timers", []() {
    TimerWheel wheel;
    assertEqual<size_t>(wheel.activeCount(), 0, "initially 0");
    wheel.addTimeout([](){}, 100);
    assertEqual<size_t>(wheel.activeCount(), 1, "after 1 timeout");
    wheel.addTimeout([](){}, 200);
    assertEqual<size_t>(wheel.activeCount(), 2, "after 2 timeouts");
    wheel.addInterval([](){}, 50);
    assertEqual<size_t>(wheel.activeCount(), 3, "after adding interval");
  }});

  suite.cases.push_back({"cancel removes a timer", []() {
    TimerWheel wheel;
    auto id1 = wheel.addTimeout([](){}, 100);
    auto id2 = wheel.addTimeout([](){}, 200);
    assertEqual<size_t>(wheel.activeCount(), 2);
    wheel.cancel(id1);
    assertEqual<size_t>(wheel.activeCount(), 1);
    wheel.cancel(id2);
    assertEqual<size_t>(wheel.activeCount(), 0);
  }});

  suite.cases.push_back({"cancel non-existent ID is safe", []() {
    TimerWheel wheel;
    wheel.addTimeout([](){}, 100);
    wheel.cancel(9999); // should not crash
    assertEqual<size_t>(wheel.activeCount(), 1);
  }});

  suite.cases.push_back({"tick fires expired timeout", []() {
    TimerWheel wheel;
    int count = 0;
    wheel.addTimeout([&count](){ count++; }, 100);

    // Get the expiry and tick past it
    auto expiry = wheel.nextExpiryMs();
    assertTrue(expiry.has_value(), "has expiry");

    wheel.tick(*expiry + 1);
    assertEqual(count, 1, "callback fired");
    assertEqual<size_t>(wheel.activeCount(), 0, "timeout removed after firing");
  }});

  suite.cases.push_back({"tick does not fire before expiry", []() {
    TimerWheel wheel;
    int count = 0;
    wheel.addTimeout([&count](){ count++; }, 100);

    auto expiry = wheel.nextExpiryMs();
    assertTrue(expiry.has_value());

    // Tick BEFORE expiry
    wheel.tick(*expiry - 1);
    assertEqual(count, 0, "should not fire yet");
    assertEqual<size_t>(wheel.activeCount(), 1);
  }});

  suite.cases.push_back({"interval re-schedules after firing", []() {
    TimerWheel wheel;
    int count = 0;
    wheel.addInterval([&count](){ count++; }, 50);

    auto expiry1 = wheel.nextExpiryMs();
    assertTrue(expiry1.has_value());

    // Fire first interval
    wheel.tick(*expiry1 + 1);
    assertEqual(count, 1, "first fire");
    assertEqual<size_t>(wheel.activeCount(), 1, "interval still active");

    // Fire second interval
    auto expiry2 = wheel.nextExpiryMs();
    assertTrue(expiry2.has_value());
    assertGreater(*expiry2, *expiry1, "next expiry is later");

    wheel.tick(*expiry2 + 1);
    assertEqual(count, 2, "second fire");
    assertEqual<size_t>(wheel.activeCount(), 1, "still active");
  }});

  suite.cases.push_back({"multiple timers fire in order", []() {
    TimerWheel wheel;
    std::vector<int> order;
    wheel.addTimeout([&order](){ order.push_back(1); }, 100);
    wheel.addTimeout([&order](){ order.push_back(2); }, 200);
    wheel.addTimeout([&order](){ order.push_back(3); }, 50);

    // Tick far enough to fire all
    auto expiry = wheel.nextExpiryMs();
    // Tick past the latest (200ms from now)
    wheel.tick(*expiry + 300);
    assertEqual<size_t>(order.size(), 3, "all fired");
    // Timer with 50ms delay fires first (smallest expiry)
    assertEqual(order[0], 3, "50ms fires first");
    assertEqual(order[1], 1, "100ms fires second");
    assertEqual(order[2], 2, "200ms fires third");
  }});

  suite.cases.push_back({"nextExpiryMs returns nullopt when empty", []() {
    TimerWheel wheel;
    assertFalse(wheel.nextExpiryMs().has_value());
  }});

  suite.cases.push_back({"pause stops firing", []() {
    TimerWheel wheel;
    int count = 0;
    wheel.addTimeout([&count](){ count++; }, 100);
    auto expiry = wheel.nextExpiryMs();

    wheel.pause();

    // nextExpiryMs returns nullopt when paused
    assertFalse(wheel.nextExpiryMs().has_value(), "no expiry while paused");

    // Tick should be no-op while paused
    wheel.tick(*expiry + 1000);
    assertEqual(count, 0, "no fire while paused");
  }});

  suite.cases.push_back({"resume recalculates expiry", []() {
    TimerWheel wheel;
    int count = 0;
    wheel.addTimeout([&count](){ count++; }, 100);

    wheel.pause();
    // Simulate time passing (resume uses steady_clock internally)
    wheel.resume();

    // After resume, timer should have a new expiry based on remaining time
    assertTrue(wheel.nextExpiryMs().has_value(), "has expiry after resume");
    assertEqual<size_t>(wheel.activeCount(), 1, "timer still exists");

    // Tick far into the future to fire it
    wheel.tick(wheel.nextExpiryMs().value() + 1);
    assertEqual(count, 1, "fires after resume");
  }});

  suite.cases.push_back({"pause/resume is idempotent", []() {
    TimerWheel wheel;
    wheel.addTimeout([](){}, 100);

    wheel.pause();
    wheel.pause(); // double pause
    wheel.resume();
    wheel.resume(); // double resume

    assertEqual<size_t>(wheel.activeCount(), 1, "timer survives double pause/resume");
  }});

  suite.cases.push_back({"cancel during pause", []() {
    TimerWheel wheel;
    auto id = wheel.addTimeout([](){}, 100);
    wheel.pause();
    wheel.cancel(id);
    assertEqual<size_t>(wheel.activeCount(), 0, "cancelled while paused");
    wheel.resume();
    assertEqual<size_t>(wheel.activeCount(), 0, "still 0 after resume");
  }});

  suite.cases.push_back({"interval cancel stops repetition", []() {
    TimerWheel wheel;
    int count = 0;
    auto id = wheel.addInterval([&count](){ count++; }, 50);

    auto expiry = wheel.nextExpiryMs();
    wheel.tick(*expiry + 1);
    assertEqual(count, 1, "fired once");

    wheel.cancel(id);
    assertEqual<size_t>(wheel.activeCount(), 0, "cancelled");

    // Tick again - should not fire
    wheel.tick(*expiry + 1000);
    assertEqual(count, 1, "no more fires after cancel");
  }});

  return suite;
}

} // namespace

void registerTimerWheelTests() {
  TestRunner::instance().addSuite(createTimerWheelTests());
}
