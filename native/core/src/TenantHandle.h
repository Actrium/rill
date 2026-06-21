#pragma once
#include "TenantContext.h"
#include "TenantThread.h"
#include <jsi/jsi.h>
#include <memory>
#include <mutex>
#include <string>

namespace rill::tenant_manager {

/// Unified wrapper around engine-specific sandbox contexts.
/// Engine type is determined at compile time by RILL_SANDBOX_ENGINE.
class TenantHandle {
public:
  TenantHandle(TenantId id, std::unique_ptr<TenantContext> context);
  ~TenantHandle();

  // Non-copyable, non-movable
  TenantHandle(const TenantHandle&) = delete;
  TenantHandle& operator=(const TenantHandle&) = delete;

  /// Create the underlying sandbox runtime + context.
  /// Must be called on the thread where the sandbox will run.
  void createSandbox(facebook::jsi::Runtime& hostRuntime, double timeout);

  /// Evaluate JS code in the sandbox context.
  facebook::jsi::Value eval(facebook::jsi::Runtime& hostRuntime,
                            const std::string& code);

  /// Set a global variable in the sandbox.
  void inject(facebook::jsi::Runtime& hostRuntime,
                 const std::string& name,
                 const facebook::jsi::Value& value);

  /// Get a global variable from the sandbox.
  facebook::jsi::Value extract(facebook::jsi::Runtime& hostRuntime,
                                 const std::string& name);

  /// Dispose the sandbox context and runtime. Idempotent.
  void dispose();

  // State accessors
  TenantId id() const { return id_; }
  TenantState state() const { return context_->state; }
  void setState(TenantState s) { context_->state = s; }
  const TenantContext& context() const { return *context_; }
  TenantContext& context() { return *context_; }

  bool isDisposed() const;

private:
  TenantId id_;
  std::unique_ptr<TenantContext> context_;
  std::recursive_mutex mutex_;

  // Engine-specific sandbox objects held as opaque shared_ptr<HostObject>.
  // Actual types: JSCSandboxRuntime/QuickJSSandboxRuntime/HermesSandboxRuntime
  // and their corresponding Context objects.
  std::shared_ptr<facebook::jsi::HostObject> sandboxRuntime_;
  std::shared_ptr<facebook::jsi::HostObject> sandboxContext_;
  bool disposed_ = false;
};

} // namespace rill::tenant_manager
