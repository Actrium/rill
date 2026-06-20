#pragma once

// HermesSandboxNAPI - Hermes sandbox adapter using N-API (jsr_*/napi_* C API).
//
// PURPOSE:
//   On Windows, the Hermes NuGet package (Microsoft.JavaScript.Hermes) only
//   exports N-API / JSR C functions (jsr_create_runtime, napi_*). It does NOT
//   ship the C++ JSI API (hermes/hermes.h, makeHermesRuntime) used by the
//   iOS/Android/macOS variant (HermesSandboxJSI.h).
//
//   This file provides the same JSI HostObject interface (__HermesSandboxJSI)
//   but internally creates and drives sandbox Hermes runtimes through the
//   N-API C surface.
//
// WHEN TO USE WHICH:
//   HermesSandboxJSI.h   - platforms with hermes C++ JSI (iOS, Android, macOS)
//   HermesSandboxNAPI.h  - platforms with N-API-only Hermes  (Windows NuGet)

#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Forward-declare N-API opaque types so we don't leak the headers here.
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_ref__* napi_ref;
typedef struct jsr_runtime_s* jsr_runtime;
typedef struct jsr_config_s* jsr_config;
typedef struct jsr_napi_env_scope_s* jsr_napi_env_scope;

namespace hermes_sandbox_napi {

using namespace facebook;

class HermesSandboxNAPIContext : public jsi::HostObject {
public:
  HermesSandboxNAPIContext(jsi::Runtime &hostRuntime, double timeout);
  ~HermesSandboxNAPIContext() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  jsi::Value eval(jsi::Runtime &rt, const std::string &code);
  jsi::Value evalBytecode(
      jsi::Runtime &rt,
      const uint8_t *bytecode,
      size_t size,
      const std::string &sourceUrl);
  jsi::Value evalBytecodeAsset(
      jsi::Runtime &rt,
      const std::string &assetPath);
  void inject(jsi::Runtime &rt, const std::string &name,
              const jsi::Value &value);
  jsi::Value extract(jsi::Runtime &rt, const std::string &name);
  void dispose();

  bool isDisposed() const { return disposed_; }

  // RAII scope guard - opens/closes jsr_napi_env_scope around N-API calls.
  // This is critical: keeping the scope open permanently corrupts the host
  // Hermes runtime's TLS state, causing crashes when returning HostObjects.
  struct EnvScope {
    napi_env env;
    jsr_napi_env_scope scope = nullptr;
    EnvScope(napi_env e);
    ~EnvScope();
    bool ok() const { return scope != nullptr; }
  };

private:
  jsr_runtime runtime_;
  napi_env env_;
  jsi::Runtime *hostRuntime_;
  bool disposed_;
  std::recursive_mutex mutex_;

  // Host function callback storage
  struct HostFnData {
    HermesSandboxNAPIContext *self;
    std::string callbackId;
  };
  std::unordered_map<std::string, std::shared_ptr<jsi::Function>> callbacks_;
  int callbackCounter_ = 0;

  // Sandbox function references (prevent GC of sandbox functions passed to host)
  std::vector<napi_ref> sandboxFuncRefs_;

  // Value conversion
  napi_value jsiToNapi(jsi::Runtime &rt, const jsi::Value &value, int depth = 0);
  jsi::Value napiToJsi(jsi::Runtime &rt, napi_value value, int depth = 0);
  napi_value wrapHostFunction(jsi::Runtime &rt, jsi::Function &&func);

  void installConsole();
  std::string getExceptionMessage();
};

class HermesSandboxNAPIRuntime : public jsi::HostObject {
public:
  HermesSandboxNAPIRuntime(jsi::Runtime &hostRuntime, double timeout);
  ~HermesSandboxNAPIRuntime() override;

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
  std::vector<std::shared_ptr<HermesSandboxNAPIContext>> contexts_;
  std::recursive_mutex mutex_;
};

class HermesSandboxNAPIModule : public jsi::HostObject {
public:
  explicit HermesSandboxNAPIModule(jsi::Runtime &runtime);
  ~HermesSandboxNAPIModule() override;

  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override;

  static void install(jsi::Runtime &runtime);
};

} // namespace hermes_sandbox_napi
