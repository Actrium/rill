#pragma once

// HermesSandboxJSI — Hermes sandbox adapter using C++ JSI (hermes/hermes.h).
//
// Requires the Hermes C++ JSI interface (facebook::hermes::makeHermesRuntime).
// Used on iOS, Android, and macOS where Hermes is built from source with full
// C++ headers available.
//
// For Windows (Hermes NuGet, N-API-only), see HermesSandboxNAPI.h instead.

#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace facebook {
namespace hermes {
class HermesRuntime;  // fwd-decl: keep the concrete runtime type off this header
}
}  // namespace facebook

namespace hermes_sandbox {

using namespace facebook;

/**
 * HermesSandboxContext - Wraps a single isolated Hermes runtime
 *
 * Exposed to JS as a HostObject with SYNCHRONOUS methods:
 * - eval(code: string): unknown
 * - inject(name: string, value: unknown): void
 * - extract(name: string): unknown
 * - dispose(): void
 */
class HermesSandboxContext : public jsi::HostObject {
public:
  HermesSandboxContext(jsi::Runtime &hostRuntime, double timeout);
  ~HermesSandboxContext() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  jsi::Value eval(jsi::Runtime &rt, const std::string &code);
  jsi::Value evalBytecode(jsi::Runtime &rt, const uint8_t *bytecode, size_t size);
  void inject(jsi::Runtime &rt, const std::string &name,
                 const jsi::Value &value);
  jsi::Value extract(jsi::Runtime &rt, const std::string &name);
  void dispose();

  bool isDisposed() const { return disposed_; }

private:
  // Stored as its concrete Hermes type (not sliced to jsi::Runtime) so the CDP
  // debug layer can hand it to CDPDebugAPI::create(HermesRuntime&). HermesRuntime
  // IS-A jsi::Runtime, so every existing jsi:: use of *sandboxRuntime_ is
  // unaffected.
  std::unique_ptr<facebook::hermes::HermesRuntime> sandboxRuntime_;
  jsi::Runtime *hostRuntime_;
  bool disposed_;
  std::recursive_mutex mutex_;

  // Callback storage for host functions wrapped in sandbox
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> callbacks_;
  int callbackCounter_ = 0;
  
  // Cache for sandbox wrappers - preserves identity when same host function is passed multiple times
  // Key: callback ID, Value: the sandbox jsi::Function wrapper
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> wrapperCache_;

  // Convert value from host runtime to sandbox runtime
  jsi::Value hostToSandbox(jsi::Runtime &hostRt, jsi::Runtime &sandboxRt,
                           const jsi::Value &value);
  // Convert value from sandbox runtime to host runtime
  jsi::Value sandboxToHost(jsi::Runtime &sandboxRt, jsi::Runtime &hostRt,
                           const jsi::Value &value);
  // Wrap a host function for use in sandbox
  jsi::Value wrapHostFunctionForSandbox(jsi::Runtime &hostRt,
                                        jsi::Runtime &sandboxRt,
                                        jsi::Function &&func);
  // Wrap a sandbox function for use in host
  jsi::Value wrapSandboxFunctionForHost(jsi::Runtime &sandboxRt,
                                        jsi::Runtime &hostRt,
                                        jsi::Function &&func);
  void installTaskQueueShim(jsi::Runtime &hostRt);
  int drainImmediateQueue(jsi::Runtime &hostRt);
  void drainMicrotasks(jsi::Runtime &hostRt);

  // Storage for sandbox functions that need to be called from host
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> sandboxFunctions_;
  int sandboxFunctionCounter_ = 0;
};

/**
 * HermesSandboxRuntime - Factory for isolated contexts
 */
class HermesSandboxRuntime : public jsi::HostObject {
public:
  HermesSandboxRuntime(jsi::Runtime &hostRuntime, double timeout);
  ~HermesSandboxRuntime() override;

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
  std::vector<std::shared_ptr<HermesSandboxContext>> contexts_;
  std::recursive_mutex mutex_;
};

/**
 * HermesSandboxModule - Top-level JSI module
 *
 * Installed as global.__HermesSandboxJSI with:
 * - createRuntime(options?: { timeout?: number }): Runtime
 * - isAvailable(): boolean
 */
class HermesSandboxModule : public jsi::HostObject {
public:
  explicit HermesSandboxModule(jsi::Runtime &runtime);
  ~HermesSandboxModule() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  static void install(jsi::Runtime &runtime);
};

// Install __HermesSandboxJSI on the given runtime
void installHermesSandbox(jsi::Runtime &runtime);

} // namespace hermes_sandbox
