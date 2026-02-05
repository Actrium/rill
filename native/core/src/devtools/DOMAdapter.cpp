/**
 * DOMAdapter.cpp
 *
 * P3-Y.5: DOM Domain Adapter Implementation
 */

#include "DOMAdapter.h"
#include <sstream>

namespace rill::devtools {

DOMAdapter::DOMAdapter(CDPServer& server)
    : server_(server) {}

void DOMAdapter::setGetDocumentCallback(GetDocumentCallback callback) {
  getDocumentCallback_ = std::move(callback);
}

void DOMAdapter::setGetChildNodesCallback(GetChildNodesCallback callback) {
  getChildNodesCallback_ = std::move(callback);
}

void DOMAdapter::setSetAttributeCallback(SetAttributeCallback callback) {
  setAttributeCallback_ = std::move(callback);
}

CDPResponse DOMAdapter::handleEnable(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DOMAdapter::handleDisable(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse DOMAdapter::handleGetDocument(TenantId tenantId, int requestId,
                                          const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  // Parse depth (default: 1, -1 means unlimited)
  int depth = 1;
  auto depthOpt = cdp::parseJSONInt(params, "depth");
  if (depthOpt) {
    depth = *depthOpt;
  }
  
  if (!getDocumentCallback_) {
    // Return minimal document
    response.result = R"({"root":{"nodeId":1,"nodeType":9,"nodeName":"#document","childNodeCount":0}})";
    return response;
  }
  
  DOMNode root = getDocumentCallback_(tenantId, depth);
  
  // Ensure root has document type
  if (root.nodeType != DOMNodeType::DOCUMENT_NODE) {
    DOMNode doc;
    doc.nodeId = generateNodeId();
    doc.nodeType = DOMNodeType::DOCUMENT_NODE;
    doc.nodeName = "#document";
    doc.localName = "#document";
    doc.childNodeCount = 1;
    doc.children.push_back(root);
    root = doc;
  }
  
  std::ostringstream ss;
  ss << "{\"root\":" << nodeToJSON(root) << "}";
  response.result = ss.str();
  return response;
}

CDPResponse DOMAdapter::handleRequestChildNodes(TenantId tenantId, int requestId,
                                                 const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto nodeIdOpt = cdp::parseJSONInt(params, "nodeId");
  if (!nodeIdOpt) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing nodeId parameter");
    return response;
  }
  
  int depth = 1;
  auto depthOpt = cdp::parseJSONInt(params, "depth");
  if (depthOpt) {
    depth = *depthOpt;
  }
  
  if (getChildNodesCallback_) {
    std::vector<DOMNode> children = getChildNodesCallback_(tenantId, *nodeIdOpt, depth);
    
    // Send setChildNodes event
    CDPEvent event;
    event.method = "DOM.setChildNodes";
    
    std::ostringstream eventParams;
    eventParams << "{\"parentId\":" << *nodeIdOpt;
    eventParams << ",\"nodes\":[";
    
    for (size_t i = 0; i < children.size(); ++i) {
      if (i > 0) eventParams << ",";
      eventParams << nodeToJSON(children[i]);
    }
    
    eventParams << "]}";
    event.params = eventParams.str();
    
    server_.sendEvent(tenantId, event);
  }
  
  response.result = "{}";
  return response;
}

CDPResponse DOMAdapter::handleGetAttributes(TenantId /*tenantId*/, int requestId,
                                             const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto nodeIdOpt = cdp::parseJSONInt(params, "nodeId");
  if (!nodeIdOpt) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing nodeId parameter");
    return response;
  }
  
  // For now, return empty attributes
  // Full implementation would query the Receiver
  response.result = R"({"attributes":[]})";
  return response;
}

CDPResponse DOMAdapter::handleSetAttributeValue(TenantId tenantId, int requestId,
                                                 const std::string& params) {
  CDPResponse response;
  response.id = requestId;
  
  auto nodeIdOpt = cdp::parseJSONInt(params, "nodeId");
  auto nameOpt = cdp::parseJSONString(params, "name");
  auto valueOpt = cdp::parseJSONString(params, "value");
  
  if (!nodeIdOpt || !nameOpt || !valueOpt) {
    response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INVALID_PARAMS,
                                         "Missing required parameters");
    return response;
  }
  
  if (setAttributeCallback_) {
    bool success = setAttributeCallback_(tenantId, *nodeIdOpt, *nameOpt, *valueOpt);
    if (!success) {
      response.error = cdp::buildErrorJSON(requestId, CDPErrorCode::INTERNAL_ERROR,
                                           "Failed to set attribute");
      return response;
    }
  }
  
  response.result = "{}";
  return response;
}

CDPResponse DOMAdapter::handleQuerySelector(TenantId /*tenantId*/, int requestId,
                                             const std::string& /*params*/) {
  CDPResponse response;
  response.id = requestId;
  
  // querySelector is complex to implement - return not found for now
  response.result = R"({"nodeId":0})";
  return response;
}

// ============================================
// Event Emitters
// ============================================

void DOMAdapter::onNodeInserted(TenantId tenantId, int parentNodeId,
                                 int previousNodeId, const DOMNode& node) {
  CDPEvent event;
  event.method = "DOM.childNodeInserted";
  
  std::ostringstream params;
  params << "{\"parentNodeId\":" << parentNodeId;
  params << ",\"previousNodeId\":" << previousNodeId;
  params << ",\"node\":" << nodeToJSON(node, false);
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void DOMAdapter::onNodeRemoved(TenantId tenantId, int parentNodeId, int nodeId) {
  CDPEvent event;
  event.method = "DOM.childNodeRemoved";
  
  std::ostringstream params;
  params << "{\"parentNodeId\":" << parentNodeId;
  params << ",\"nodeId\":" << nodeId;
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void DOMAdapter::onAttributeModified(TenantId tenantId, int nodeId,
                                      const std::string& name, const std::string& value) {
  CDPEvent event;
  event.method = "DOM.attributeModified";
  
  std::ostringstream params;
  params << "{\"nodeId\":" << nodeId;
  params << ",\"name\":\"" << cdp::escapeJSON(name) << "\"";
  params << ",\"value\":\"" << cdp::escapeJSON(value) << "\"";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void DOMAdapter::onAttributeRemoved(TenantId tenantId, int nodeId, const std::string& name) {
  CDPEvent event;
  event.method = "DOM.attributeRemoved";
  
  std::ostringstream params;
  params << "{\"nodeId\":" << nodeId;
  params << ",\"name\":\"" << cdp::escapeJSON(name) << "\"";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void DOMAdapter::onCharacterDataModified(TenantId tenantId, int nodeId,
                                          const std::string& characterData) {
  CDPEvent event;
  event.method = "DOM.characterDataModified";
  
  std::ostringstream params;
  params << "{\"nodeId\":" << nodeId;
  params << ",\"characterData\":\"" << cdp::escapeJSON(characterData) << "\"";
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

void DOMAdapter::onChildNodeCountUpdated(TenantId tenantId, int nodeId, int childNodeCount) {
  CDPEvent event;
  event.method = "DOM.childNodeCountUpdated";
  
  std::ostringstream params;
  params << "{\"nodeId\":" << nodeId;
  params << ",\"childNodeCount\":" << childNodeCount;
  params << "}";
  
  event.params = params.str();
  server_.sendEvent(tenantId, event);
}

// ============================================
// Private Methods
// ============================================

std::string DOMAdapter::nodeToJSON(const DOMNode& node, bool includeChildren) {
  std::ostringstream ss;
  ss << "{";
  ss << "\"nodeId\":" << node.nodeId;
  ss << ",\"nodeType\":" << node.nodeType;
  ss << ",\"nodeName\":\"" << cdp::escapeJSON(node.nodeName) << "\"";
  ss << ",\"localName\":\"" << cdp::escapeJSON(node.localName) << "\"";
  
  if (!node.nodeValue.empty()) {
    ss << ",\"nodeValue\":\"" << cdp::escapeJSON(node.nodeValue) << "\"";
  }
  
  ss << ",\"childNodeCount\":" << node.childNodeCount;
  
  // Attributes
  if (!node.attributes.empty()) {
    ss << ",\"attributes\":[";
    for (size_t i = 0; i < node.attributes.size(); ++i) {
      if (i > 0) ss << ",";
      ss << "\"" << cdp::escapeJSON(node.attributes[i].first) << "\"";
      ss << ",\"" << cdp::escapeJSON(node.attributes[i].second) << "\"";
    }
    ss << "]";
  }
  
  // Children
  if (includeChildren && !node.children.empty()) {
    ss << ",\"children\":[";
    for (size_t i = 0; i < node.children.size(); ++i) {
      if (i > 0) ss << ",";
      ss << nodeToJSON(node.children[i], true);
    }
    ss << "]";
  }
  
  ss << "}";
  return ss.str();
}

int DOMAdapter::generateNodeId() {
  return nextNodeId_.fetch_add(1);
}

int DOMAdapter::mapRillNodeId(TenantId tenantId, int rillNodeId) {
  std::lock_guard<std::mutex> lock(mapMutex_);
  
  uint64_t key = (static_cast<uint64_t>(tenantId) << 32) | static_cast<uint64_t>(rillNodeId);
  
  auto it = reverseNodeIdMap_.find(key);
  if (it != reverseNodeIdMap_.end()) {
    return it->second;
  }
  
  int cdpNodeId = generateNodeId();
  nodeIdMap_[cdpNodeId] = {tenantId, rillNodeId};
  reverseNodeIdMap_[key] = cdpNodeId;
  
  return cdpNodeId;
}

int DOMAdapter::getRillNodeId(int cdpNodeId) {
  std::lock_guard<std::mutex> lock(mapMutex_);
  
  auto it = nodeIdMap_.find(cdpNodeId);
  if (it != nodeIdMap_.end()) {
    return it->second.second;
  }
  
  return 0;
}

} // namespace rill::devtools
