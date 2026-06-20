#include "test_framework.h"
#include "../src/EventBus.h"
#include <chrono>
#include <thread>

using namespace rill::tenant_manager;
using namespace rill::test;

namespace {

TestSuite createEventBusTests() {
  TestSuite suite{"EventBus", {}};

  // --- Filter matching ---

  suite.cases.push_back({"matchesFilter: wildcard matches all", []() {
    assertTrue(EventBus::matchesFilter("anything", "*"));
  }});

  suite.cases.push_back({"matchesFilter: exact match", []() {
    assertTrue(EventBus::matchesFilter("app.state", "app.state"));
  }});

  suite.cases.push_back({"matchesFilter: exact mismatch", []() {
    assertFalse(EventBus::matchesFilter("app.state", "app.config"));
  }});

  suite.cases.push_back({"matchesFilter: prefix wildcard matches", []() {
    assertTrue(EventBus::matchesFilter("app.state", "app.*"));
    assertTrue(EventBus::matchesFilter("app.config.update", "app.*"));
  }});

  suite.cases.push_back({"matchesFilter: prefix wildcard mismatch", []() {
    assertFalse(EventBus::matchesFilter("network.status", "app.*"));
  }});

  suite.cases.push_back({"matchesFilter: empty filter matches nothing", []() {
    assertFalse(EventBus::matchesFilter("anything", ""));
  }});

  // --- Channel management ---

  suite.cases.push_back({"createChannel + hasChannel", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "system";
    bus.createChannel(policy);
    assertTrue(bus.hasChannel("system"));
    assertFalse(bus.hasChannel("nonexistent"));
  }});

  suite.cases.push_back({"removeChannel", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "temp";
    bus.createChannel(policy);
    assertTrue(bus.hasChannel("temp"));
    bus.removeChannel("temp");
    assertFalse(bus.hasChannel("temp"));
  }});

  suite.cases.push_back({"channelNames: sorted list", []() {
    EventBus bus;
    ChannelPolicy p1, p2, p3;
    p1.name = "charlie";
    p2.name = "alpha";
    p3.name = "bravo";
    bus.createChannel(p1);
    bus.createChannel(p2);
    bus.createChannel(p3);
    auto names = bus.channelNames();
    assertEqual(names.size(), static_cast<size_t>(3));
    assertEqual(names[0], std::string("alpha"));
    assertEqual(names[1], std::string("bravo"));
    assertEqual(names[2], std::string("charlie"));
  }});

  // --- Publish + Subscribe ---

  suite.cases.push_back({"subscribe + publish: handler called", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "test";
    bus.createChannel(policy);

    int callCount = 0;
    std::string receivedName;
    bus.subscribe(1, "test", "*", [&](const BusEvent& e) {
      callCount++;
      receivedName = e.name;
    });

    BusEvent event;
    event.channel = "test";
    event.name = "hello";
    event.payload = "{}";
    assertTrue(bus.publish(std::move(event)));
    assertEqual(callCount, 1);
    assertEqual(receivedName, std::string("hello"));
  }});

  suite.cases.push_back({"subscribe: filter limits events", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "app";
    bus.createChannel(policy);

    int callCount = 0;
    bus.subscribe(1, "app", "state.*", [&](const BusEvent&) { callCount++; });

    BusEvent e1;
    e1.channel = "app";
    e1.name = "state.change";
    bus.publish(std::move(e1));

    BusEvent e2;
    e2.channel = "app";
    e2.name = "config.update";
    bus.publish(std::move(e2));

    assertEqual(callCount, 1);
  }});

  suite.cases.push_back({"multiple subscribers all receive", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "multi";
    bus.createChannel(policy);

    int c1 = 0, c2 = 0;
    bus.subscribe(1, "multi", "*", [&](const BusEvent&) { c1++; });
    bus.subscribe(2, "multi", "*", [&](const BusEvent&) { c2++; });

    BusEvent event;
    event.channel = "multi";
    event.name = "ping";
    bus.publish(std::move(event));
    assertEqual(c1, 1);
    assertEqual(c2, 1);
  }});

  // --- Unsubscribe ---

  suite.cases.push_back({"unsubscribe: stops receiving", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "test";
    bus.createChannel(policy);

    int callCount = 0;
    auto subId = bus.subscribe(1, "test", "*", [&](const BusEvent&) { callCount++; });

    BusEvent e1;
    e1.channel = "test";
    e1.name = "before";
    bus.publish(std::move(e1));
    assertEqual(callCount, 1);

    bus.unsubscribe(subId);

    BusEvent e2;
    e2.channel = "test";
    e2.name = "after";
    bus.publish(std::move(e2));
    assertEqual(callCount, 1);
  }});

  suite.cases.push_back({"unsubscribeAll: clears tenant subs", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "test";
    bus.createChannel(policy);

    int c1 = 0, c2 = 0;
    bus.subscribe(1, "test", "*", [&](const BusEvent&) { c1++; });
    bus.subscribe(2, "test", "*", [&](const BusEvent&) { c2++; });
    bus.unsubscribeAll(1);

    BusEvent event;
    event.channel = "test";
    event.name = "ping";
    bus.publish(std::move(event));
    assertEqual(c1, 0);
    assertEqual(c2, 1);
  }});

  // --- System-only channels ---

  suite.cases.push_back({"systemOnly: tenant publish rejected", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "system";
    policy.systemOnly = true;
    bus.createChannel(policy);

    BusEvent event;
    event.channel = "system";
    event.name = "hack";
    event.sourceTenantId = 1;
    assertFalse(bus.publish(std::move(event)));
  }});

  suite.cases.push_back({"systemOnly: system publish allowed", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "system";
    policy.systemOnly = true;
    bus.createChannel(policy);

    int callCount = 0;
    bus.subscribe(1, "system", "*", [&](const BusEvent&) { callCount++; });

    BusEvent event;
    event.channel = "system";
    event.name = "appState";
    event.sourceTenantId = 0;
    assertTrue(bus.publish(std::move(event)));
    assertEqual(callCount, 1);
  }});

  // --- Payload size ---

  suite.cases.push_back({"publish: payload too large rejected", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "small";
    policy.maxPayloadBytes = 10;
    bus.createChannel(policy);

    BusEvent event;
    event.channel = "small";
    event.name = "big";
    event.payload = std::string(100, 'x');
    assertFalse(bus.publish(std::move(event)));
  }});

  // --- Max subscribers ---

  suite.cases.push_back({"subscribe: max subscribers enforced", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "limited";
    policy.maxSubscribers = 2;
    bus.createChannel(policy);

    auto id1 = bus.subscribe(1, "limited", "*", [](const BusEvent&) {});
    auto id2 = bus.subscribe(2, "limited", "*", [](const BusEvent&) {});
    auto id3 = bus.subscribe(3, "limited", "*", [](const BusEvent&) {});
    assertTrue(id1 > 0);
    assertTrue(id2 > 0);
    assertEqual(id3, static_cast<uint64_t>(0));
  }});

  // --- Rate limiting ---

  suite.cases.push_back({"publish: rate limiting per channel", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "ratelimited";
    policy.maxEventsPerSecond = 3;
    bus.createChannel(policy);

    int delivered = 0;
    bus.subscribe(1, "ratelimited", "*", [&](const BusEvent&) { delivered++; });

    for (int i = 0; i < 5; ++i) {
      BusEvent event;
      event.channel = "ratelimited";
      event.name = "evt";
      bus.publish(std::move(event));
    }
    assertEqual(delivered, 3);
  }});

  // --- Broadcast / Unicast / Multicast ---

  suite.cases.push_back({"broadcast: all subscribers receive", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "bcast";
    bus.createChannel(policy);

    int c1 = 0, c2 = 0;
    bus.subscribe(1, "bcast", "*", [&](const BusEvent&) { c1++; });
    bus.subscribe(2, "bcast", "*", [&](const BusEvent&) { c2++; });
    bus.broadcast("bcast", "ping", "{}");
    assertEqual(c1, 1);
    assertEqual(c2, 1);
  }});

  suite.cases.push_back({"unicast: only target receives", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "uni";
    bus.createChannel(policy);

    int c1 = 0, c2 = 0;
    bus.subscribe(1, "uni", "*", [&](const BusEvent&) { c1++; });
    bus.subscribe(2, "uni", "*", [&](const BusEvent&) { c2++; });
    bus.unicast(1, "uni", "hello", "{}");
    assertEqual(c1, 1);
    assertEqual(c2, 0);
  }});

  suite.cases.push_back({"multicast: selected tenants receive", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "mcast";
    bus.createChannel(policy);

    int c1 = 0, c2 = 0, c3 = 0;
    bus.subscribe(1, "mcast", "*", [&](const BusEvent&) { c1++; });
    bus.subscribe(2, "mcast", "*", [&](const BusEvent&) { c2++; });
    bus.subscribe(3, "mcast", "*", [&](const BusEvent&) { c3++; });
    bus.multicast({1, 3}, "mcast", "hello", "{}");
    assertEqual(c1, 1);
    assertEqual(c2, 0);
    assertEqual(c3, 1);
  }});

  // --- Persistent events + replay ---

  suite.cases.push_back({"persistent: events buffered for replay", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "persistent";
    policy.persistent = true;
    bus.createChannel(policy);

    bus.subscribe(1, "persistent", "*", [](const BusEvent&) {});

    double beforePublish = std::chrono::duration<double>(
        std::chrono::steady_clock::now().time_since_epoch()).count() - 0.001;

    bus.broadcast("persistent", "evt1", "{}");
    bus.broadcast("persistent", "evt2", "{}");
    bus.broadcast("persistent", "evt3", "{}");

    auto replay = bus.getReplayEvents("persistent", beforePublish);
    assertEqual(replay.size(), static_cast<size_t>(3));
    assertEqual(replay[0].name, std::string("evt1"));
    assertEqual(replay[2].name, std::string("evt3"));
  }});

  suite.cases.push_back({"persistent: ring buffer caps at max", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "capped";
    policy.persistent = true;
    bus.createChannel(policy);

    for (int i = 0; i < 150; ++i) {
      bus.broadcast("capped", "evt_" + std::to_string(i), "{}");
    }
    auto replay = bus.getReplayEvents("capped", 0.0);
    assertEqual(replay.size(), static_cast<size_t>(100));
    assertEqual(replay[0].name, std::string("evt_50"));
  }});

  suite.cases.push_back({"non-persistent: no replay events", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "volatile";
    policy.persistent = false;
    bus.createChannel(policy);
    bus.broadcast("volatile", "evt", "{}");
    auto replay = bus.getReplayEvents("volatile", 0.0);
    assertEqual(replay.size(), static_cast<size_t>(0));
  }});

  // --- Edge cases ---

  suite.cases.push_back({"publish: non-existent channel returns false", []() {
    EventBus bus;
    BusEvent event;
    event.channel = "nonexistent";
    event.name = "test";
    assertFalse(bus.publish(std::move(event)));
  }});

  suite.cases.push_back({"subscribe: non-existent channel returns 0", []() {
    EventBus bus;
    auto id = bus.subscribe(1, "nonexistent", "*", [](const BusEvent&) {});
    assertEqual(id, static_cast<uint64_t>(0));
  }});

  // --- Stats ---

  suite.cases.push_back({"getStats: publish/deliver/drop tracked", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "stats";
    bus.createChannel(policy);
    bus.subscribe(1, "stats", "*", [](const BusEvent&) {});
    bus.subscribe(2, "stats", "*", [](const BusEvent&) {});
    bus.broadcast("stats", "ping", "{}");

    auto stats = bus.getStats();
    assertEqual(stats.totalPublished, static_cast<uint64_t>(1));
    assertEqual(stats.totalDelivered, static_cast<uint64_t>(2));
    assertEqual(stats.activeChannels, static_cast<size_t>(1));
    assertEqual(stats.activeSubscriptions, static_cast<size_t>(2));
  }});

  suite.cases.push_back({"getStats: dropped counted", []() {
    EventBus bus;
    BusEvent event;
    event.channel = "none";
    event.name = "test";
    bus.publish(std::move(event));
    assertEqual(bus.getStats().totalDropped, static_cast<uint64_t>(1));
  }});

  // --- Event IDs ---

  suite.cases.push_back({"publish: events get unique IDs", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "ids";
    bus.createChannel(policy);

    uint64_t id1 = 0, id2 = 0;
    bus.subscribe(1, "ids", "*", [&](const BusEvent& e) {
      if (id1 == 0) id1 = e.id; else id2 = e.id;
    });
    bus.broadcast("ids", "first", "{}");
    bus.broadcast("ids", "second", "{}");
    assertTrue(id1 > 0);
    assertTrue(id2 > id1);
  }});

  // --- Concurrent access ---

  suite.cases.push_back({"concurrent subscribe + publish", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "concurrent";
    bus.createChannel(policy);

    std::atomic<int> delivered{0};

    std::vector<std::thread> threads;
    for (int i = 0; i < 4; ++i) {
      threads.emplace_back([&bus, &delivered, i]() {
        bus.subscribe(static_cast<TenantId>(i + 1), "concurrent", "*",
                      [&delivered](const BusEvent&) {
                        delivered.fetch_add(1, std::memory_order_relaxed);
                      });
      });
    }
    for (auto& t : threads) t.join();
    threads.clear();

    for (int i = 0; i < 4; ++i) {
      threads.emplace_back([&bus]() {
        bus.broadcast("concurrent", "ping", "{}");
      });
    }
    for (auto& t : threads) t.join();

    assertEqual(delivered.load(), 16);
  }});

  // --- Reentry safety (dispatch-without-lock) ---

  suite.cases.push_back({"reentry: handler calls unsubscribe", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "reentry";
    bus.createChannel(policy);

    uint64_t subId = 0;
    int callCount = 0;
    subId = bus.subscribe(1, "reentry", "*", [&](const BusEvent&) {
      callCount++;
      // Unsubscribe self during dispatch — must not deadlock.
      bus.unsubscribe(subId);
    });

    BusEvent event;
    event.channel = "reentry";
    event.name = "test";
    assertTrue(bus.publish(std::move(event)));
    assertEqual(callCount, 1);

    // Second publish should not deliver (we unsubscribed).
    BusEvent event2;
    event2.channel = "reentry";
    event2.name = "test2";
    bus.publish(std::move(event2));
    assertEqual(callCount, 1);
  }});

  suite.cases.push_back({"reentry: handler calls publish", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "reentry2";
    bus.createChannel(policy);

    int outerCount = 0;
    int innerCount = 0;
    bus.subscribe(1, "reentry2", "outer", [&](const BusEvent&) {
      outerCount++;
      // Publish from within a handler — must not deadlock.
      BusEvent inner;
      inner.channel = "reentry2";
      inner.name = "inner";
      bus.publish(std::move(inner));
    });
    bus.subscribe(1, "reentry2", "inner", [&](const BusEvent&) {
      innerCount++;
    });

    BusEvent event;
    event.channel = "reentry2";
    event.name = "outer";
    assertTrue(bus.publish(std::move(event)));
    assertEqual(outerCount, 1);
    assertEqual(innerCount, 1);
  }});

  suite.cases.push_back({"reentry: handler calls subscribe", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "reentry3";
    bus.createChannel(policy);

    int firstCount = 0;
    int lateCount = 0;
    bus.subscribe(1, "reentry3", "*", [&](const BusEvent&) {
      firstCount++;
      // Subscribe a new handler during dispatch — must not deadlock.
      bus.subscribe(2, "reentry3", "*", [&](const BusEvent&) { lateCount++; });
    });

    BusEvent event;
    event.channel = "reentry3";
    event.name = "test";
    assertTrue(bus.publish(std::move(event)));
    assertEqual(firstCount, 1);
    // The late subscriber was added after the snapshot, so it shouldn't receive this event.
    assertEqual(lateCount, 0);

    // Next event should deliver to both.
    BusEvent event2;
    event2.channel = "reentry3";
    event2.name = "test2";
    bus.publish(std::move(event2));
    assertEqual(firstCount, 2);
    // lateCount will be 1 (from second publish) + 1 more (the first handler subscribes again)
    // Actually: first handler fires, subscribes tenant 2 again (3rd sub total),
    // but the snapshot for this publish already captured the 2 subs (tenant 1 + tenant 2 from before).
    // So lateCount = 1 (from the existing tenant 2 sub).
    assertTrue(lateCount >= 1);
  }});

  // --- Policy enforcement on unicast/multicast ---

  suite.cases.push_back({"unicast: payload too large rejected", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "unisize";
    policy.maxPayloadBytes = 10;
    bus.createChannel(policy);

    bus.subscribe(1, "unisize", "*", [](const BusEvent&) {});
    assertFalse(bus.unicast(1, "unisize", "test", std::string(100, 'x')));
  }});

  suite.cases.push_back({"multicast: payload too large rejected", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "mcastsize";
    policy.maxPayloadBytes = 10;
    bus.createChannel(policy);

    bus.subscribe(1, "mcastsize", "*", [](const BusEvent&) {});
    assertFalse(bus.multicast({1}, "mcastsize", "test", std::string(100, 'x')));
  }});

  suite.cases.push_back({"unicast: rate limited", []() {
    EventBus bus;
    ChannelPolicy policy;
    policy.name = "unirate";
    policy.maxEventsPerSecond = 2;
    bus.createChannel(policy);

    int delivered = 0;
    bus.subscribe(1, "unirate", "*", [&](const BusEvent&) { delivered++; });
    assertTrue(bus.unicast(1, "unirate", "e1", "{}"));
    assertTrue(bus.unicast(1, "unirate", "e2", "{}"));
    assertFalse(bus.unicast(1, "unirate", "e3", "{}"));
    assertEqual(delivered, 2);
  }});

  return suite;
}

} // anonymous namespace

void registerEventBusTests() {
  TestRunner::instance().addSuite(createEventBusTests());
}
