/**
 * RuntimeAdapter.cpp
 *
 * P3-Y.4: Runtime Domain Adapter Implementation
 */

#include "RuntimeAdapter.h"
#include <sstream>

namespace rill::devtools {

RuntimeAdapter::RuntimeAdapter(CDPServer& server)
    : server_(server) {}

void RuntimeAdapter::setEvaluateCallback(EvaluateInGuestCallback callback) {
  evaluateCallback_ = std::move(callback);
}

void RuntimeAdapter::setGetPropertiesCallback(GetPropertiesCallback callback) {
  getPropertiesCallback_ = std::move(callback);
}

CDPResponse RuntimeAdapter::handleEnable(TenantId tenantId, int requestId) {
  // Send executionContextCreated event
  sendExecutionContextCreated(tenantId, "Rill Guest Context");
  
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse RuntimeAdapter::handleDisable(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse RuntimeAdapter::handleEvaluate(TenantId tenantId, int requestId,
                                           const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  // Parse params
  auto expression = cdp::parseJSONString(params, "expression");
  if (!expression) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing expression parameter");
    return response;
  }
  
  // Optional params
  bool returnByValue = false;
  bool generatePreview = false;
  
  auto returnByValueOpt = cdp::parseJSONString(params, "returnByValue");
  if (returnByValueOpt && *returnByValueOpt == "true") {
    returnByValue = true;
  }
  
  // Evaluate
  if (!evaluateCallback_) {
    // No callback set - return undefined
    response.result = R"({"result":{"type":"undefined"}})";
    return response;
  }
  
  EvaluateResult result = evaluateCallback_(tenantId, *expression, returnByValue, generatePreview);
  
  std::ostringstream ss;
  ss << "{\"result\":" << buildRemoteObjectJSON(result);
  
  if (!result.success) {
    ss << ",\"exceptionDetails\":" << buildExceptionDetailsJSON(result);
  }
  
  ss << "}";
  response.result = ss.str();
  return response;
}

CDPResponse RuntimeAdapter::handleGetProperties(TenantId tenantId, int requestId,
                                                 const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto objectId = cdp::parseJSONString(params, "objectId");
  if (!objectId) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing objectId parameter");
    return response;
  }
  
  bool ownProperties = true;
  
  if (getPropertiesCallback_) {
    std::string propertiesJSON = getPropertiesCallback_(tenantId, *objectId, ownProperties);
    response.result = "{\"result\":" + propertiesJSON + "}";
  } else {
    response.result = R"({"result":[]})";
  }
  
  return response;
}

CDPResponse RuntimeAdapter::handleCallFunctionOn(TenantId /*tenantId*/, int requestId,
                                                  const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  // Parse params
  auto functionDeclaration = cdp::parseJSONString(params, "functionDeclaration");
  auto objectId = cdp::parseJSONString(params, "objectId");
  
  if (!functionDeclaration) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing functionDeclaration parameter");
    return response;
  }
  
  // For now, we don't support callFunctionOn - return undefined
  // Full implementation would need to maintain object references
  response.result = R"({"result":{"type":"undefined"}})";
  return response;
}

CDPResponse RuntimeAdapter::handleGetHeapUsage(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  
  // We don't have direct access to heap usage, return placeholder
  response.result = R"({"usedSize":0,"totalSize":0})";
  return response;
}

void RuntimeAdapter::sendExecutionContextCreated(TenantId tenantId, const std::string& name) {
  CDPEvent event;
  event.method = "Runtime.executionContextCreated";
  
  std::ostringstream params;
  params << "{\"context\":{";
  params << "\"id\":" << tenantId;
  params << ",\"origin\":\"rill://tenant/" << tenantId << "\"";
  params << ",\"name\":\"" << cdp::escapeJSON(name) << "\"";
  params << "}}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void RuntimeAdapter::sendExecutionContextDestroyed(TenantId tenantId) {
  CDPEvent event;
  event.method = "Runtime.executionContextDestroyed";
  
  std::ostringstream params;
  params << "{\"executionContextId\":" << tenantId << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

std::string RuntimeAdapter::buildRemoteObjectJSON(const EvaluateResult& result) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"type\":\"" << result.type << "\"";
  
  if (!result.subtype.empty()) {
    ss << ",\"subtype\":\"" << result.subtype << "\"";
  }
  
  // Value - depends on type
  if (result.type == "undefined") {
    // No value for undefined
  } else if (result.type == "null" || result.subtype == "null") {
    ss << ",\"value\":null";
  } else if (result.type == "boolean") {
    ss << ",\"value\":" << result.value;
  } else if (result.type == "number") {
    ss << ",\"value\":" << result.value;
    ss << ",\"description\":\"" << result.value << "\"";
  } else if (result.type == "string") {
    ss << ",\"value\":\"" << cdp::escapeJSON(result.value) << "\"";
  } else if (result.type == "object" || result.type == "function") {
    if (!result.description.empty()) {
      ss << ",\"description\":\"" << cdp::escapeJSON(result.description) << "\"";
    }
    if (!result.objectId.empty()) {
      ss << ",\"objectId\":\"" << cdp::escapeJSON(result.objectId) << "\"";
    }
  }
  
  ss << "}";
  return ss.str();
}

std::string RuntimeAdapter::buildExceptionDetailsJSON(const EvaluateResult& result) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"exceptionId\":1";
  ss << ",\"text\":\"" << cdp::escapeJSON(result.errorMessage) << "\"";
  ss << ",\"lineNumber\":0";
  ss << ",\"columnNumber\":0";
  
  ss << ",\"exception\":{";
  ss << "\"type\":\"object\"";
  ss << ",\"subtype\":\"error\"";
  ss << ",\"className\":\"Error\"";
  ss << ",\"description\":\"" << cdp::escapeJSON(result.errorMessage) << "\"";
  ss << "}";
  
  ss << "}";
  return ss.str();
}

} // namespace rill::devtools
