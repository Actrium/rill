/**
 * RuntimeAdapter.h
 *
 * P3-Y.4: Runtime Domain Adapter
 *
 * Handles CDP Runtime domain methods:
 *   - Runtime.evaluate: Execute expression in Guest context
 *   - Runtime.getProperties: Get object properties
 *   - Runtime.callFunctionOn: Call function on object
 */

#pragma once

#include "CDPServer.h"
#include <functional>
#include <string>
#include <unordered_map>

namespace rill::devtools {

// ============================================
// Evaluate Callback Types
// ============================================

/**
 * Result of evaluating an expression
 */
struct EvaluateResult {
  bool success = false;
  std::string type;        // "undefined", "null", "boolean", "number", "string", "object", "function"
  std::string subtype;     // "null", "array", "error", etc.
  std::string value;       // JSON-encoded value or primitive
  std::string description; // Human-readable description
  std::string objectId;    // Object ID for further inspection
  
  // Error info (if !success)
  std::string errorMessage;
  std::string errorStack;
};

/**
 * Callback to evaluate expression in Guest context
 */
using EvaluateInGuestCallback = std::function<EvaluateResult(
  TenantId tenantId,
  const std::string& expression,
  bool returnByValue,
  bool generatePreview
)>;

/**
 * Callback to get object properties
 */
using GetPropertiesCallback = std::function<std::string(
  TenantId tenantId,
  const std::string& objectId,
  bool ownProperties
)>;

// ============================================
// Runtime Adapter
// ============================================

/**
 * Adapter for CDP Runtime domain
 */
class RuntimeAdapter {
public:
  explicit RuntimeAdapter(CDPServer& server);
  ~RuntimeAdapter() = default;
  
  // Non-copyable
  RuntimeAdapter(const RuntimeAdapter&) = delete;
  RuntimeAdapter& operator=(const RuntimeAdapter&) = delete;
  
  /**
   * Set callback for evaluating expressions
   */
  void setEvaluateCallback(EvaluateInGuestCallback callback);
  
  /**
   * Set callback for getting object properties
   */
  void setGetPropertiesCallback(GetPropertiesCallback callback);
  
  /**
   * Handle CDP Runtime.enable
   */
  CDPResponse handleEnable(TenantId tenantId, int requestId);
  
  /**
   * Handle CDP Runtime.disable
   */
  CDPResponse handleDisable(TenantId tenantId, int requestId);
  
  /**
   * Handle CDP Runtime.evaluate
   */
  CDPResponse handleEvaluate(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle CDP Runtime.getProperties
   */
  CDPResponse handleGetProperties(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle CDP Runtime.callFunctionOn
   */
  CDPResponse handleCallFunctionOn(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle CDP Runtime.getHeapUsage
   */
  CDPResponse handleGetHeapUsage(TenantId tenantId, int requestId);
  
  /**
   * Send Runtime.executionContextCreated event
   */
  void sendExecutionContextCreated(TenantId tenantId, const std::string& name);
  
  /**
   * Send Runtime.executionContextDestroyed event
   */
  void sendExecutionContextDestroyed(TenantId tenantId);

private:
  /**
   * Build RemoteObject JSON from EvaluateResult
   */
  std::string buildRemoteObjectJSON(const EvaluateResult& result);
  
  /**
   * Build ExceptionDetails JSON from EvaluateResult
   */
  std::string buildExceptionDetailsJSON(const EvaluateResult& result);
  
  CDPServer& server_;
  EvaluateInGuestCallback evaluateCallback_;
  GetPropertiesCallback getPropertiesCallback_;
};

} // namespace rill::devtools
