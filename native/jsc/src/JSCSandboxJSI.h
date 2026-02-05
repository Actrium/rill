#pragma once

#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace jsc_sandbox {

using namespace facebook;

/**
 * JSCSandboxContext - Wraps a single isolated JSContext
 *
 * Exposed to JS as a HostObject with SYNCHRONOUS methods:
 * - eval(code: string): unknown
 * - inject(name: string, value: unknown): void
 * - extract(name: string): unknown
 * - dispose(): void
 */
class JSCSandboxContext : public jsi::HostObject {
public:
  JSCSandboxContext(jsi::Runtime &hostRuntime, double timeout);
  ~JSCSandboxContext() override;

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
  void *jsContext_; // JSContext* (opaque)
  jsi::Runtime *hostRuntime_;
  bool disposed_;
  std::recursive_mutex mutex_;

  // Callback storage for functions passed from host
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> callbacks_;
  
  // Cache for Host Function -> Proxy ID
  // Key: Unique identifier for the host function object (if available)
  // Since we can't easily get a stable ID from jsi::Function, we will use
  // a WeakMap-like approach on the JS side or simply try to cache by
  // hashing the function object if possible.
  //
  // BUT: In JSI, we can attach properties to HostObjects (if it is one),
  // but standard JS functions are opaque.
  //
  // Alternative: We can attach a hidden property to the host function
  // Reserved: callback counter was used for proxy ID assignment.
  // Kept as comment for reference; remove once proxy approach is finalized.

  void *jsiToJSValue(jsi::Runtime &rt, const jsi::Value &value);
  jsi::Value jsValueToJSI(jsi::Runtime &rt, void *jsValue);
  jsi::Value jsValueToJSI(jsi::Runtime &rt, void *jsValue, int depth,
                          std::unordered_set<const void *> *visited = nullptr);
  void *wrapFunctionForSandbox(jsi::Runtime &rt, jsi::Function &&func);
};

/**
 * JSCSandboxRuntime - Factory for isolated contexts
 */
class JSCSandboxRuntime : public jsi::HostObject {
public:
  JSCSandboxRuntime(jsi::Runtime &hostRuntime, double timeout);
  ~JSCSandboxRuntime() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  jsi::Value createContext(jsi::Runtime &rt);
  void dispose();

private:
  jsi::Runtime *hostRuntime_;
  double timeout_;
  bool disposed_;
  std::vector<std::shared_ptr<JSCSandboxContext>> contexts_;
  std::recursive_mutex mutex_;
};

/**
 * JSCSandboxModule - Top-level JSI module
 *
 * Installed as global.__JSCSandboxJSI with:
 * - createRuntime(options?: { timeout?: number }): Runtime
 * - isAvailable(): boolean
 */
class JSCSandboxModule : public jsi::HostObject {
public:
  explicit JSCSandboxModule(jsi::Runtime &runtime);
  ~JSCSandboxModule() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  static void install(jsi::Runtime &runtime);
};

} // namespace jsc_sandbox
