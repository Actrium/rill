// Native behavioural test for the eval-timeout watchdog x debugger-pause
// reconciliation (see HermesSandboxContext's debugger event callback).
//
// The watchdog (HermesRuntime::watchTimeLimit) is a wall-clock timer: an armed
// eval that runs longer than the budget is killed with an async break. A CDP
// breakpoint pauses the runtime thread mid-eval, but the timer keeps ticking, so
// sitting at a breakpoint past the budget would kill the program the moment it
// resumes. The fix suspends the watchdog on every pause (unwatchTimeLimit) and
// re-arms it on resume.
//
// This drives a REAL HermesRuntime + CDPDebugAPI through the shipped
// CDPAgentTarget and measures the actual behaviour with the reconciliation OFF
// (negative control: the program is expected to be killed) and ON (the program
// is expected to survive a pause far longer than its budget).
//
// Build + run with build-run-watchdog.sh, HERMES_DESTROOT pointing at a React
// Native Hermes pod's `destroot`.

#include <hermes/AsyncDebuggerAPI.h>
#include <hermes/Public/RuntimeConfig.h>
#include <hermes/cdp/CDPAgent.h>
#include <hermes/cdp/CDPDebugAPI.h>
#include <hermes/hermes.h>

#include <jsi/jsi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

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
  bool waitFor(const std::string& needle, const char* label) {
    std::unique_lock<std::mutex> lk(m);
    bool ok = cv.wait_for(lk, std::chrono::seconds(10),
                          [&] { return all.find(needle) != std::string::npos; });
    if (!ok) std::cout << "  (timeout waiting for " << label << ")\n";
    return ok;
  }
  void reset() {
    std::lock_guard<std::mutex> lk(m);
    all.clear();
  }
};

}  // namespace

int main() {
  std::cout << "=== Hermes watchdog x pause reconciliation e2e ===\n";

  // A budget far shorter than how long we sit at the breakpoint, so an
  // un-suspended watchdog is guaranteed to expire during the pause.
  const uint32_t kBudgetMs = 150;
  const auto kPauseHold = std::chrono::milliseconds(600);

  TaskPump pump;
  std::promise<
      std::pair<facebook::hermes::HermesRuntime*, std::shared_ptr<hcdp::CDPDebugAPI>>>
      ready;
  auto readyFut = ready.get_future();

  std::thread runtimeThread([&] {
    auto runtime = facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig());
    facebook::hermes::HermesRuntime* rtPtr = runtime.get();
    std::shared_ptr<hcdp::CDPDebugAPI> debugAPI = hcdp::CDPDebugAPI::create(*runtime);
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
      task();
    }
    debugAPI.reset();
    runtime.reset();
  });

  auto readyPair = readyFut.get();
  facebook::hermes::HermesRuntime* rtPtr = readyPair.first;
  std::shared_ptr<hcdp::CDPDebugAPI> debugAPI = readyPair.second;

  // The reconciliation, toggled per pass. This mirrors HermesSandboxContext's
  // ctor callback exactly. Fires on the runtime thread.
  std::atomic<bool> reconcile{false};
  bool suspended = false;  // runtime-thread-only
  debugAPI->asyncDebuggerAPI().addDebuggerEventCallback_TS(
      [&reconcile, &suspended, kBudgetMs](
          facebook::hermes::HermesRuntime& rt, hdbg::AsyncDebuggerAPI&,
          hdbg::DebuggerEventType ev) {
        if (!reconcile.load()) return;
        using ET = hdbg::DebuggerEventType;
        switch (ev) {
          case ET::Breakpoint:
          case ET::DebuggerStatement:
          case ET::StepFinish:
          case ET::ExplicitPause:
          case ET::Exception:
            if (!suspended) {
              rt.unwatchTimeLimit();
              suspended = true;
            }
            break;
          case ET::Resumed:
            if (suspended) {
              rt.watchTimeLimit(kBudgetMs);
              suspended = false;
            }
            break;
          default:
            break;
        }
      });

  hdbg::EnqueueRuntimeTaskFunc enqueue = [&pump, rtPtr](hdbg::RuntimeTask t) {
    pump.push([rtPtr, t = std::move(t)]() { t(*rtPtr); });
  };

  Sink sink;
  auto target = std::make_shared<rill::devtools::CDPAgentTarget>(
      /*execCtxId=*/1, debugAPI, std::move(enqueue));
  const rill::devtools::ConnectionId conn = 1;
  target->onClientConnect(conn, [&sink](const std::string& m) { sink(m); });
  target->dispatch(conn, R"({"id":1,"method":"Debugger.enable"})");
  sink.waitFor("\"id\":1", "Debugger.enable");

  // One pass: arm the watchdog, eval `debugger; <marker>`, hold the pause well
  // past the budget, resume, and report the marker global. `threw` reports
  // whether the eval was killed by the timeout — that (not the marker, which the
  // fast assignment may set before the async break is honoured) is the signal
  // that the watchdog fired across the pause. reqId keeps CDP ids unique.
  bool threw = false;
  auto runPass = [&](int marker, int reqId) -> int {
    sink.reset();
    threw = false;
    std::promise<void> evalDone;
    auto evalFut = evalDone.get_future();
    std::atomic<bool> didThrow{false};
    const std::string js = "debugger; globalThis.__wd = " + std::to_string(marker) + ";";
    pump.push([rtPtr, js, &evalDone, &didThrow] {
      rtPtr->watchTimeLimit(kBudgetMs);
      try {
        rtPtr->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(js), "wd.js");
      } catch (const std::exception& e) {
        didThrow.store(true);
        std::cout << "    (eval threw: " << e.what() << ")\n";
      }
      rtPtr->unwatchTimeLimit();
      evalDone.set_value();
    });

    if (!sink.waitFor("\"Debugger.paused\"", "paused")) return -2;
    // Hold the breakpoint far longer than the budget: an un-suspended watchdog
    // expires here.
    std::this_thread::sleep_for(kPauseHold);
    target->dispatch(
        conn, std::string("{\"id\":") + std::to_string(reqId) +
                  ",\"method\":\"Debugger.resume\"}");
    if (evalFut.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
      return -3;
    threw = didThrow.load();

    std::promise<int> wd;
    auto wdFut = wd.get_future();
    pump.push([rtPtr, &wd] {
      auto v = rtPtr->global().getProperty(*rtPtr, "__wd");
      wd.set_value(v.isNumber() ? static_cast<int>(v.getNumber()) : -1);
    });
    return wdFut.wait_for(std::chrono::seconds(5)) == std::future_status::ready
               ? wdFut.get()
               : -4;
  };

  // Negative control: reconciliation OFF. The watchdog expires during the hold,
  // so the resumed eval is killed before it can assign __wd (stays 41).
  rtPtr->global().setProperty(*rtPtr, "__wd", 41);
  reconcile.store(false);
  int off = runPass(/*marker=*/7, /*reqId=*/3);
  bool offThrew = threw;
  std::cout << "    [reconcile OFF] threw=" << offThrew << " __wd=" << off
            << " (budget " << kBudgetMs << "ms, held " << kPauseHold.count()
            << "ms)\n";
  check(offThrew,
        "without reconciliation the watchdog fires across the pause and kills "
        "the eval (TimeoutError)");

  // Positive: reconciliation ON. The watchdog is suspended for the whole pause,
  // so the program is not killed and completes (__wd == 9, no throw).
  rtPtr->global().setProperty(*rtPtr, "__wd", 41);
  reconcile.store(true);
  int on = runPass(/*marker=*/9, /*reqId=*/4);
  std::cout << "    [reconcile ON ] threw=" << threw << " __wd=" << on << "\n";
  check(!threw && on == 9,
        "with reconciliation the program survives a pause far past the budget");

  target->onClientDisconnect(conn);
  target.reset();
  debugAPI.reset();
  pump.requestStop();
  runtimeThread.join();
  check(true, "clean teardown without deadlock");

  std::cout << "=== " << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " ("
            << g_failures << " failed) ===\n";
  return g_failures == 0 ? 0 : 1;
}
