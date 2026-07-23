// Native integration e2e for the Hermes CDP relay.
//
// Wires a REAL facebook::hermes::HermesRuntime + CDPDebugAPI to our production
// rill::devtools::CDPAgentTarget (the same class the pod ships) and drives it
// with raw CDP messages, exactly as CDPServer would. It proves the runtime
// behaviour that syntax checks cannot:
//   1. Debugger.enable / Runtime.enable round-trip responses through the
//      per-connection sink.
//   2. A `debugger;` statement pauses the runtime thread and a Debugger.paused
//      event is delivered out-of-band through that sink.
//   3. Debugger.resume, fed through CDPAgentTarget::dispatch() from another
//      thread, unblocks the paused runtime so the eval finishes (side effect
//      __x === 42 becomes observable).
//   4. onClientDisconnect tears the agent down without deadlock.
//
// The task pump here stands in for the RN CallInvoker: it delivers Hermes
// runtime tasks onto the one thread that owns the runtime.
//
// This test links against a Hermes built WITH the debugger (CDP symbols), so it
// is not part of the portable native/core suite. Build + run with build-run.sh,
// pointing HERMES_DESTROOT at a React Native Hermes pod's `destroot` directory
// (the one that ships hermes.framework and include/hermes/cdp/*).

#include <hermes/AsyncDebuggerAPI.h>
#include <hermes/Public/RuntimeConfig.h>
#include <hermes/cdp/CDPAgent.h>
#include <hermes/cdp/CDPDebugAPI.h>
#include <hermes/hermes.h>

#include <jsi/jsi.h>

#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

// Activate the gated body of the production target.
#define RILL_WIP_CDP_DEVTOOLS 1
#include "CDPAgentTarget.h"

using namespace facebook;
namespace hcdp = facebook::hermes::cdp;
namespace hdbg = facebook::hermes::debugger;

namespace {

int g_failures = 0;
void check(bool ok, const std::string& what) {
  std::cout << (ok ? "  PASS  " : "  FAIL  ") << what << "\n";
  if (!ok) ++g_failures;
}

// Runtime-thread task pump (stands in for the host CallInvoker).
struct TaskPump {
  std::mutex m;
  std::condition_variable cv;
  std::deque<std::function<void()>> q;
  bool stop = false;

  void push(std::function<void()> f) {
    {
      std::lock_guard<std::mutex> lk(m);
      q.push_back(std::move(f));
    }
    cv.notify_all();
  }
  void requestStop() {
    {
      std::lock_guard<std::mutex> lk(m);
      stop = true;
    }
    cv.notify_all();
  }
};

// Thread-safe collector for messages emitted on the connection sink.
struct Sink {
  std::mutex m;
  std::condition_variable cv;
  std::string all;

  void operator()(const std::string& msg) {
    std::lock_guard<std::mutex> lk(m);
    all += msg;
    all += '\n';
    cv.notify_all();
  }
  // Wait until `needle` has appeared, or fail after a hang-guard deadline.
  bool waitFor(const std::string& needle, const char* label) {
    std::unique_lock<std::mutex> lk(m);
    bool ok = cv.wait_for(lk, std::chrono::seconds(10),
                          [&] { return all.find(needle) != std::string::npos; });
    if (!ok) {
      std::cout << "  (timeout waiting for " << label << ")\n";
    }
    return ok;
  }
};

}  // namespace

int main() {
  std::cout << "=== Hermes CDP relay native e2e ===\n";

  TaskPump pump;
  std::promise<
      std::pair<facebook::hermes::HermesRuntime*, std::shared_ptr<hcdp::CDPDebugAPI>>>
      ready;
  auto readyFut = ready.get_future();

  // Runtime thread: owns the runtime + CDPDebugAPI and runs all runtime tasks.
  std::thread runtimeThread([&] {
    auto runtime = facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig());
    facebook::hermes::HermesRuntime* rtPtr = runtime.get();
    std::shared_ptr<hcdp::CDPDebugAPI> debugAPI =
        hcdp::CDPDebugAPI::create(*runtime);
    ready.set_value({rtPtr, debugAPI});

    for (;;) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lk(pump.m);
        pump.cv.wait(lk, [&] { return !pump.q.empty() || pump.stop; });
        if (pump.q.empty() && pump.stop) break;
        task = std::move(pump.q.front());
        pump.q.pop_front();
      }
      task();  // a paused eval blocks HERE; resume arrives via Hermes interrupt
    }

    // Destroy CDPDebugAPI before the runtime, on the runtime thread.
    debugAPI.reset();
    runtime.reset();
  });

  // Plain locals (not structured bindings) so the task lambdas can capture them
  // under C++17 without the C++20 structured-binding-capture extension.
  auto readyPair = readyFut.get();
  facebook::hermes::HermesRuntime* rtPtr = readyPair.first;
  std::shared_ptr<hcdp::CDPDebugAPI> debugAPI = readyPair.second;

  // enqueue: deliver each Hermes runtime task onto the runtime thread.
  hdbg::EnqueueRuntimeTaskFunc enqueue = [&pump, rtPtr](hdbg::RuntimeTask t) {
    pump.push([rtPtr, t = std::move(t)]() { t(*rtPtr); });
  };

  Sink sink;
  auto target = std::make_shared<rill::devtools::CDPAgentTarget>(
      /*execCtxId=*/1, debugAPI, std::move(enqueue));

  const rill::devtools::ConnectionId conn = 1;
  target->onClientConnect(conn, [&sink](const std::string& m) { sink(m); });

  // 1. Enable domains and confirm responses come back through the sink.
  target->dispatch(conn, R"({"id":1,"method":"Debugger.enable"})");
  check(sink.waitFor("\"id\":1", "Debugger.enable response"),
        "Debugger.enable acknowledged via sink");
  target->dispatch(conn, R"({"id":2,"method":"Runtime.enable"})");
  check(sink.waitFor("\"id\":2", "Runtime.enable response"),
        "Runtime.enable acknowledged via sink");

  // 2. Evaluate JS that hits `debugger;` -> the runtime thread pauses inside it.
  std::promise<void> evalDone;
  auto evalFut = evalDone.get_future();
  pump.push([rtPtr, &evalDone] {
    try {
      rtPtr->evaluateJavaScript(
          std::make_shared<jsi::StringBuffer>("debugger; globalThis.__x = 42;"),
          "e2e.js");
    } catch (const std::exception& e) {
      std::cout << "  (eval threw: " << e.what() << ")\n";
    }
    evalDone.set_value();
  });

  check(sink.waitFor("\"Debugger.paused\"", "Debugger.paused event"),
        "debugger; statement paused and reported Debugger.paused out-of-band");

  // eval must still be blocked (paused) at this point.
  bool blockedWhilePaused =
      evalFut.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready;
  check(blockedWhilePaused, "runtime thread stays blocked while paused");

  // 3. Resume through dispatch() from this (non-runtime) thread.
  target->dispatch(conn, R"({"id":3,"method":"Debugger.resume"})");
  bool resumed =
      evalFut.wait_for(std::chrono::seconds(10)) == std::future_status::ready;
  check(resumed, "Debugger.resume unblocked the paused runtime thread");

  // 4. Confirm the post-resume side effect executed.
  std::promise<int> xVal;
  auto xFut = xVal.get_future();
  pump.push([rtPtr, &xVal] {
    auto v = rtPtr->global().getProperty(*rtPtr, "__x");
    xVal.set_value(v.isNumber() ? static_cast<int>(v.getNumber()) : -1);
  });
  int x = xFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready
              ? xFut.get()
              : -1;
  check(x == 42, "post-resume side effect observed (__x === 42)");

  // 5. Teardown: disconnect, drop the target, stop the runtime thread.
  target->onClientDisconnect(conn);
  target.reset();  // release our CDPDebugAPI ref before the runtime thread exits
  debugAPI.reset();
  pump.requestStop();
  runtimeThread.join();
  check(true, "clean teardown without deadlock");

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES")
            << " (" << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
