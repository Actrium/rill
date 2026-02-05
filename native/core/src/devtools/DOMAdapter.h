/**
 * DOMAdapter.h
 *
 * P3-Y.5: DOM Domain Adapter
 *
 * Maps Rill component tree to CDP DOM domain.
 * Handles:
 *   - DOM.getDocument
 *   - DOM.requestChildNodes
 *   - DOM.getAttributes
 *   - DOM.setAttributeValue
 *   - DOM mutation events
 */

#pragma once

#include "CDPServer.h"
#include <functional>
#include <string>
#include <vector>
#include <unordered_map>

namespace rill::devtools {

// ============================================
// DOM Node Types
// ============================================

/**
 * CDP DOM node type constants
 */
namespace DOMNodeType {
  constexpr int ELEMENT_NODE = 1;
  constexpr int TEXT_NODE = 3;
  constexpr int DOCUMENT_NODE = 9;
}

/**
 * Simplified DOM node representation
 */
struct DOMNode {
  int nodeId = 0;           // CDP node ID (unique across all tenants)
  int nodeType = DOMNodeType::ELEMENT_NODE;
  std::string nodeName;     // Component type (e.g., "View", "Text")
  std::string localName;    // Lowercase name
  std::string nodeValue;    // Text content (for text nodes)
  
  // Attributes (props)
  std::vector<std::pair<std::string, std::string>> attributes;
  
  // Children
  int childNodeCount = 0;
  std::vector<DOMNode> children;
  
  // For mapping back to Rill
  int rillNodeId = 0;       // Original Rill node ID
};

/**
 * Callback to get component tree from Receiver
 * Returns root DOMNode with children populated to requested depth
 */
using GetDocumentCallback = std::function<DOMNode(
  TenantId tenantId,
  int depth  // -1 for unlimited
)>;

/**
 * Callback to get child nodes for a node
 */
using GetChildNodesCallback = std::function<std::vector<DOMNode>(
  TenantId tenantId,
  int nodeId,
  int depth
)>;

/**
 * Callback to set attribute (prop) on a node
 */
using SetAttributeCallback = std::function<bool(
  TenantId tenantId,
  int nodeId,
  const std::string& name,
  const std::string& value
)>;

// ============================================
// DOM Adapter
// ============================================

/**
 * Adapter for CDP DOM domain
 */
class DOMAdapter {
public:
  explicit DOMAdapter(CDPServer& server);
  ~DOMAdapter() = default;
  
  // Non-copyable
  DOMAdapter(const DOMAdapter&) = delete;
  DOMAdapter& operator=(const DOMAdapter&) = delete;
  
  /**
   * Set callback for getting document
   */
  void setGetDocumentCallback(GetDocumentCallback callback);
  
  /**
   * Set callback for getting child nodes
   */
  void setGetChildNodesCallback(GetChildNodesCallback callback);
  
  /**
   * Set callback for setting attributes
   */
  void setSetAttributeCallback(SetAttributeCallback callback);
  
  // ============================================
  // CDP Method Handlers
  // ============================================
  
  /**
   * Handle DOM.enable
   */
  CDPResponse handleEnable(TenantId tenantId, int requestId);
  
  /**
   * Handle DOM.disable
   */
  CDPResponse handleDisable(TenantId tenantId, int requestId);
  
  /**
   * Handle DOM.getDocument
   */
  CDPResponse handleGetDocument(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle DOM.requestChildNodes
   */
  CDPResponse handleRequestChildNodes(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle DOM.getAttributes
   */
  CDPResponse handleGetAttributes(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle DOM.setAttributeValue
   */
  CDPResponse handleSetAttributeValue(TenantId tenantId, int requestId, const std::string& params);
  
  /**
   * Handle DOM.querySelector
   */
  CDPResponse handleQuerySelector(TenantId tenantId, int requestId, const std::string& params);
  
  // ============================================
  // Event Emitters (called when tree changes)
  // ============================================
  
  /**
   * Emit DOM.childNodeInserted event
   */
  void onNodeInserted(TenantId tenantId, int parentNodeId, int previousNodeId, const DOMNode& node);
  
  /**
   * Emit DOM.childNodeRemoved event
   */
  void onNodeRemoved(TenantId tenantId, int parentNodeId, int nodeId);
  
  /**
   * Emit DOM.attributeModified event
   */
  void onAttributeModified(TenantId tenantId, int nodeId, const std::string& name, const std::string& value);
  
  /**
   * Emit DOM.attributeRemoved event
   */
  void onAttributeRemoved(TenantId tenantId, int nodeId, const std::string& name);
  
  /**
   * Emit DOM.characterDataModified event (for text nodes)
   */
  void onCharacterDataModified(TenantId tenantId, int nodeId, const std::string& characterData);
  
  /**
   * Emit DOM.childNodeCountUpdated event
   */
  void onChildNodeCountUpdated(TenantId tenantId, int nodeId, int childNodeCount);

private:
  /**
   * Serialize DOMNode to CDP JSON
   */
  std::string nodeToJSON(const DOMNode& node, bool includeChildren = true);
  
  /**
   * Generate unique CDP node ID
   */
  int generateNodeId();
  
  /**
   * Map Rill node ID to CDP node ID
   */
  int mapRillNodeId(TenantId tenantId, int rillNodeId);
  
  /**
   * Get Rill node ID from CDP node ID
   */
  int getRillNodeId(int cdpNodeId);
  
  CDPServer& server_;
  
  // Callbacks
  GetDocumentCallback getDocumentCallback_;
  GetChildNodesCallback getChildNodesCallback_;
  SetAttributeCallback setAttributeCallback_;
  
  // Node ID management
  std::atomic<int> nextNodeId_{1};
  
  // Mapping: CDP node ID -> (tenant ID, Rill node ID)
  std::unordered_map<int, std::pair<TenantId, int>> nodeIdMap_;
  
  // Reverse mapping: (tenant ID, Rill node ID) -> CDP node ID
  std::unordered_map<uint64_t, int> reverseNodeIdMap_;
  
  std::mutex mapMutex_;
};

} // namespace rill::devtools
