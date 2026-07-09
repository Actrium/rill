#pragma once

#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <quickjs.h>
#include <string>
#include <unordered_map>

#ifdef RILL_QJS_DEBUG
#include "devtools/CdpDebuggable.h"  // rill::devtools::ICdpDebuggable (capability seam)
namespace rill { namespace qjs_debug { class QuickJSDebugCore; } }
#endif

namespace quickjs_sandbox {

using namespace facebook;

/**
 * QuickJSSandboxContext - Wraps a single isolated QuickJS context
 *
 * Exposed to JS as a HostObject with SYNCHRONOUS methods:
 * - eval(code: string): unknown
 * - inject(name: string, value: unknown): void
 * - extract(name: string): unknown
 * - dispose(): void
 */
class QuickJSSandboxContext : public jsi::HostObject
#ifdef RILL_QJS_DEBUG
    ,
    public rill::devtools::ICdpDebuggable
#endif
{
public:
  QuickJSSandboxContext(jsi::Runtime &hostRuntime, JSRuntime *qjsRuntime,
                        double timeout);
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

#ifdef RILL_QJS_DEBUG
  // ICdpDebuggable: build a per-tenant CDP target over this context's debug core
  // (the adapter path — QuickJS has no native CDP agent). callInvoker is unused:
  // QuickJS pauses by blocking its own runtime thread and resumes via the core's
  // condition variable from the CDP thread, so no runtime-task pump is needed.
  std::shared_ptr<rill::devtools::IEngineDebugTarget> createCdpDebugTarget(
      std::shared_ptr<facebook::react::CallInvoker> callInvoker,
      std::int32_t executionContextId) override;
#endif

private:
  JSContext *qjsContext_;
  JSRuntime *qjsRuntime_; // Shared runtime (owned by QuickJSSandboxRuntime)
#ifdef RILL_QJS_DEBUG
  // Per-context engine debug controller (registers the interpreter hook). Reset
  // before the context is torn down. Dev-only.
  std::unique_ptr<rill::qjs_debug::QuickJSDebugCore> debugCore_;
#endif
  jsi::Runtime *hostRuntime_;
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
  bool disposed_;
  std::vector<std::shared_ptr<QuickJSSandboxContext>> contexts_;
  std::recursive_mutex mutex_;
};

/**
 * QuickJSSandboxModule - Top-level JSI module
 *
 * Installed as global.__QuickJSSandboxJSI with:
 * - createRuntime(options?: { timeout?: number }): Runtime
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
