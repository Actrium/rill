#pragma once

#include <atomic>
#include <chrono>
#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <quickjs.h>
#include <string>
#include <unordered_map>

namespace quickjs_sandbox {

using namespace facebook;

/**
 * InterruptState - shared wall-clock deadline for the sandbox JSRuntime.
 *
 * QuickJS invokes the runtime-level interrupt handler periodically while JS
 * executes; the handler returns 1 to abort execution. One JSRuntime is shared
 * by all contexts of a QuickJSSandboxRuntime and execution on it is
 * single-threaded, so a single deadline slot per runtime is sufficient.
 * Owned via shared_ptr so a context kept alive by JS after the runtime host
 * object is destroyed never dereferences a dangling pointer.
 */
struct InterruptState {
  // Whether a deadline is currently armed (an eval is in flight).
  std::atomic<bool> armed{false};
  // Deadline in steady_clock milliseconds since epoch of that clock.
  std::atomic<int64_t> deadlineMs{0};
  // Set by the interrupt handler when it aborted execution due to timeout;
  // used to convert QuickJS's generic "interrupted" exception into a clear
  // timeout error for the caller.
  std::atomic<bool> fired{false};
};

/**
 * DeadlineGuard - RAII helper that arms the interrupt deadline for one
 * top-level entry into sandbox JS execution.
 *
 * - timeoutMs <= 0, NaN, Infinity or otherwise not representable as an
 *   int64 millisecond deadline means "no limit": nothing is armed.
 * - Nested entries (host callback re-entering the sandbox during an eval)
 *   keep the OUTERMOST deadline: the guard only arms when none is active,
 *   so a tenant cannot extend its budget by bouncing through host callbacks.
 */
class DeadlineGuard {
public:
  DeadlineGuard(InterruptState *state, double timeoutMs) : state_(state) {
    // Guard the double->int64 cast below: casting a value outside int64's
    // range (Infinity, or callers passing e.g. Number.MAX_VALUE) is undefined
    // behavior and platform-divergent (x86 wraps negative, ARM saturates).
    // Anything that large — like NaN and <= 0, both rejected by the
    // `timeoutMs > 0` comparison — means "no limit".
    constexpr double kMaxTimeoutMs = 9.0e15; // ~285k years; safely castable
    if (!(timeoutMs > 0) || timeoutMs >= kMaxTimeoutMs) {
      return;
    }
    if (state_ && !state_->armed.load(std::memory_order_relaxed)) {
      auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::steady_clock::now().time_since_epoch())
                     .count();
      state_->deadlineMs.store(now + static_cast<int64_t>(timeoutMs),
                               std::memory_order_relaxed);
      state_->fired.store(false, std::memory_order_relaxed);
      state_->armed.store(true, std::memory_order_release);
      armedHere_ = true;
    }
  }
  ~DeadlineGuard() {
    if (armedHere_) {
      state_->armed.store(false, std::memory_order_release);
    }
  }
  DeadlineGuard(const DeadlineGuard &) = delete;
  DeadlineGuard &operator=(const DeadlineGuard &) = delete;

  // True if the interrupt handler aborted execution because THIS guard's
  // deadline expired.
  bool timedOut() const {
    return armedHere_ && state_->fired.load(std::memory_order_acquire);
  }

private:
  InterruptState *state_;
  bool armedHere_ = false;
};

/**
 * QuickJSSandboxContext - Wraps a single isolated QuickJS context
 *
 * Exposed to JS as a HostObject with SYNCHRONOUS methods:
 * - eval(code: string): unknown
 * - inject(name: string, value: unknown): void
 * - extract(name: string): unknown
 * - dispose(): void
 */
class QuickJSSandboxContext : public jsi::HostObject {
public:
  QuickJSSandboxContext(jsi::Runtime &hostRuntime, JSRuntime *qjsRuntime,
                        double timeoutMs,
                        std::shared_ptr<InterruptState> interruptState);
  ~QuickJSSandboxContext() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  jsi::Value eval(jsi::Runtime &rt, const std::string &code);
  void inject(jsi::Runtime &rt, const std::string &name,
                 const jsi::Value &value);
  jsi::Value extract(jsi::Runtime &rt, const std::string &name);
  void dispose();

  bool isDisposed() const { return disposed_; }

private:
  JSContext *qjsContext_;
  JSRuntime *qjsRuntime_; // Shared runtime (owned by QuickJSSandboxRuntime)
  jsi::Runtime *hostRuntime_;
  // Wall-clock execution budget per top-level eval; <= 0 means unlimited.
  double timeoutMs_;
  // Shared with QuickJSSandboxRuntime, read by its interrupt handler.
  std::shared_ptr<InterruptState> interruptState_;
  bool disposed_;
  std::recursive_mutex mutex_;

  // Callback storage for functions passed from host
  struct HostFunctionData {
    QuickJSSandboxContext *self;
    std::shared_ptr<jsi::Function> func;
    std::string callbackId;
  };
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> callbacks_;
  std::unordered_map<std::string, JSValue> wrapperCache_; // Cache JSValue wrappers for identity
  int callbackCounter_;

  // JS class for HostFunctionData opaque storage
  static JSClassID hostFunctionDataClassID_;
  static void hostFunctionDataFinalizer(JSRuntime *rt, JSValue val);
  void ensureClassRegistered();

  JSValue jsiToQJS(jsi::Runtime &rt, const jsi::Value &value, int depth = 0);
  jsi::Value qjsToJSI(jsi::Runtime &rt, JSValue value, int depth = 0);
  JSValue wrapFunctionForSandbox(jsi::Runtime &rt, jsi::Function &&func);

  void checkException();
  void installConsole();

  static JSValue hostFunctionCallback(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv, int magic,
                                      JSValue *func_data);
};

/**
 * QuickJSSandboxRuntime - Factory for isolated contexts
 */
class QuickJSSandboxRuntime : public jsi::HostObject {
public:
  QuickJSSandboxRuntime(jsi::Runtime &hostRuntime, double timeout);
  ~QuickJSSandboxRuntime() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  jsi::Value createContext(jsi::Runtime &rt);
  void dispose();

private:
  JSRuntime *qjsRuntime_;
  jsi::Runtime *hostRuntime_;
  double timeout_;
  // Deadline state polled by the JS_SetInterruptHandler callback installed
  // on qjsRuntime_. Shared with every context created from this runtime.
  std::shared_ptr<InterruptState> interruptState_;
  bool disposed_;
  std::vector<std::shared_ptr<QuickJSSandboxContext>> contexts_;
  std::recursive_mutex mutex_;
};

/**
 * QuickJSSandboxModule - Top-level JSI module
 *
 * Installed as global.__QuickJSSandboxJSI with:
 * - createRuntime(options?: { timeout?: number }): Runtime
 *   timeout is a wall-clock budget in milliseconds applied to each top-level
 *   eval (default 30000). A tenant script exceeding it is interrupted via
 *   JS_SetInterruptHandler and the eval throws a timeout error; the context
 *   remains usable afterwards. timeout <= 0 disables the limit.
 * - isAvailable(): boolean
 */
class QuickJSSandboxModule : public jsi::HostObject {
public:
  explicit QuickJSSandboxModule(jsi::Runtime &runtime);
  ~QuickJSSandboxModule() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  static void install(jsi::Runtime &runtime);
};

} // namespace quickjs_sandbox
