/**
 * InstructionDecoder.h
 *
 * P3-X.2: Binary Instruction Decoder
 *
 * Zero-copy decoder for binary instruction batches.
 * Features:
 *   - Header-only fast path for batch metadata
 *   - Iterator-based operation traversal
 *   - Lazy props decoding (on-demand)
 *   - String intern table with string_view (no allocations)
 */

#pragma once

#include "InstructionFormat.h"

#include <optional>
#include <span>
#include <stdexcept>

namespace rill::protocol {

// ============================================
// Decoded Structures
// ============================================

/**
 * Decoded batch header (zero-copy)
 */
struct DecodedBatchHeader {
  uint32_t magic = 0;
  uint16_t version = 0;
  uint32_t batchId = 0;
  uint16_t opCount = 0;
  uint8_t flags = 0;
  
  // Points to original buffer
  const uint8_t* data = nullptr;
  size_t dataSize = 0;
  
  // Offsets into buffer
  size_t internTableOffset = 0;
  size_t operationsOffset = 0;
  
  bool isValid() const {
    return magic == RILL_MAGIC && version == PROTOCOL_VERSION;
  }
  
  bool hasTimestamps() const {
    return (flags & BatchFlags::HAS_TIMESTAMPS) != 0;
  }
  
  bool isDeltaIntern() const {
    return (flags & BatchFlags::DELTA_INTERN) != 0;
  }
};

/**
 * Decoded value (lazy - may reference original buffer)
 */
struct DecodedValue {
  ValueType type = ValueType::INVALID;
  
  // Value storage (union-like, depends on type)
  union {
    bool boolValue;
    int32_t int32Value;
    double float64Value;
    uint16_t internIndex;  // For STRING, FUNCTION, etc.
  };
  
  // For compound types, points to raw data for lazy decoding
  const uint8_t* compoundData = nullptr;
  size_t compoundSize = 0;
  
  // Helpers
  bool isNull() const { return type == ValueType::VNULL; }
  bool isUndefined() const { return type == ValueType::UNDEFINED; }
  bool isBool() const { return type == ValueType::BOOL_FALSE || type == ValueType::BOOL_TRUE; }
  bool isNumber() const { 
    return type == ValueType::INT32 || type == ValueType::FLOAT64 ||
           type == ValueType::INT8 || type == ValueType::INT16 ||
           type == ValueType::UINT8 || type == ValueType::UINT16 ||
           type == ValueType::FLOAT32;
  }
  bool isString() const { return type == ValueType::STRING; }
  bool isFunction() const { return type == ValueType::FUNCTION; }
  bool isObject() const { return type == ValueType::OBJECT; }
  bool isArray() const { return type == ValueType::ARRAY; }
  
  bool getBool() const { return type == ValueType::BOOL_TRUE; }
  double getNumber() const {
    if (type == ValueType::FLOAT64) return float64Value;
    if (type == ValueType::INT32) return static_cast<double>(int32Value);
    return 0.0;
  }
};

/**
 * Decoded property entry
 */
struct DecodedProp {
  uint16_t keyIndex = 0;      // Intern table index for key name
  DecodedValue value;
};

/**
 * Decoded props table (lazy)
 */
struct DecodedPropsTable {
  uint16_t count = 0;
  const uint8_t* data = nullptr;
  size_t dataSize = 0;
};

/**
 * Decoded operation (common fields + type-specific data)
 */
struct DecodedOperation {
  OpType type = OpType::INVALID;
  uint32_t nodeId = 0;
  std::optional<uint64_t> timestamp;
  
  // Type-specific fields (named structs to avoid -Wnested-anon-types)
  struct CreateData {
    uint16_t typeIndex;      // Intern index for component type
    DecodedPropsTable props;
  };
  struct UpdateData {
    DecodedPropsTable props;
    uint16_t removedCount;
    // Points into the original buffer (packed little-endian u16 array).
    // Do not reinterpret_cast to uint16_t* (may be unaligned); use readU16LE.
    const uint8_t* removedIndicesData;
  };
  struct TreeData {  // APPEND, REMOVE
    uint32_t parentId;
    uint32_t childId;
  };
  struct InsertData {
    uint32_t parentId;
    uint32_t childId;
    uint16_t index;
  };
  struct ReorderData {
    uint32_t parentId;
    uint16_t childCount;
    // Points into the original buffer (packed little-endian u32 array).
    // Do not reinterpret_cast to uint32_t* (may be unaligned); use readU32LE.
    const uint8_t* childIdsData;
  };
  struct TextData {
    uint16_t textIndex;      // Intern index for text content
  };
  struct RefCallData {
    uint16_t methodIndex;    // Intern index for method name
    uint16_t callIdIndex;    // Intern index for call ID
    const uint8_t* argsData;
    size_t argsSize;
  };

  union {
    CreateData create;
    UpdateData update;
    TreeData tree;
    InsertData insert;
    ReorderData reorder;
    TextData text;
    RefCallData refCall;
  };

  DecodedOperation() : create{} {}  // Initialize first union member
};

// ============================================
// Intern Table
// ============================================

/**
 * String intern table (zero-copy using string_view)
 */
class InternTable {
public:
  InternTable() = default;
  
  /**
   * Parse intern table from buffer
   * @return Number of bytes consumed, or 0 on error
   */
  size_t parse(const uint8_t* data, size_t maxSize);
  
  /**
   * Get string at index
   * @throws std::out_of_range if index invalid
   */
  std::string_view get(uint16_t index) const;
  
  /**
   * Get string at index, or empty if invalid
   */
  std::string_view tryGet(uint16_t index) const noexcept;
  
  /**
   * Number of strings
   */
  uint16_t size() const { return static_cast<uint16_t>(strings_.size()); }
  
  /**
   * Check if index is valid
   */
  bool isValid(uint16_t index) const { return index < strings_.size(); }
  
  /**
   * Clear table
   */
  void clear() { strings_.clear(); }

private:
  std::vector<std::string_view> strings_;
};

// ============================================
// Operation Iterator
// ============================================

/**
 * Iterator for traversing operations in a decoded batch
 */
class OperationIterator {
public:
  OperationIterator() = default;
  OperationIterator(const uint8_t* data, size_t size, uint16_t count, 
                    bool hasTimestamps, const InternTable* internTable);
  
  /**
   * Check if more operations available
   */
  bool hasNext() const { return currentIndex_ < totalCount_; }
  
  /**
   * Get current index (0-based)
   */
  uint16_t currentIndex() const { return currentIndex_; }
  
  /**
   * Total operation count
   */
  uint16_t totalCount() const { return totalCount_; }
  
  /**
   * Decode and return next operation
   * @throws std::runtime_error on decode error
   */
  DecodedOperation next();
  
  /**
   * Skip to next operation without full decode
   * @return true if skipped successfully
   */
  bool skip();
  
  /**
   * Get last decode error
   */
  DecodeError lastError() const { return lastError_; }

private:
  size_t decodeOperation(DecodedOperation& op);
  // Scan a props table starting at `pos` and advance `pos` past the table.
  // Returns the number of bytes consumed (including the u16 count), or 0 on error.
  size_t decodePropsTable(size_t& pos, DecodedPropsTable& props);
  size_t skipPropsTable();
  size_t decodeValue(DecodedValue& value);
  // Skip a value starting at `pos` and advance `pos` past the value.
  // Returns the number of bytes consumed (including the ValueType byte), or 0 on error.
  size_t skipValue(size_t& pos);
  
  const uint8_t* data_ = nullptr;
  size_t dataSize_ = 0;
  size_t position_ = 0;
  uint16_t currentIndex_ = 0;
  uint16_t totalCount_ = 0;
  bool hasTimestamps_ = false;
  const InternTable* internTable_ = nullptr;
  DecodeError lastError_ = DecodeError::OK;
};

// ============================================
// Props Iterator
// ============================================

/**
 * Iterator for traversing properties in a props table
 */
class PropsIterator {
public:
  PropsIterator() = default;
  PropsIterator(const DecodedPropsTable& table, const InternTable* internTable);
  
  bool hasNext() const { return currentIndex_ < totalCount_; }
  uint16_t currentIndex() const { return currentIndex_; }
  uint16_t totalCount() const { return totalCount_; }
  
  /**
   * Decode next property
   */
  DecodedProp next();
  
private:
  const uint8_t* data_ = nullptr;
  size_t dataSize_ = 0;
  size_t position_ = 0;
  uint16_t currentIndex_ = 0;
  uint16_t totalCount_ = 0;
  [[maybe_unused]] const InternTable* internTable_ = nullptr;
};

// ============================================
// Main Decoder Class
// ============================================

/**
 * Binary instruction batch decoder
 *
 * Usage:
 *   InstructionDecoder decoder;
 *   auto header = decoder.decodeHeader(data, size);
 *   if (!header || !header->isValid()) { // handle error }
 *   
 *   auto iter = decoder.createIterator(*header);
 *   while (iter.hasNext()) {
 *     auto op = iter.next();
 *     // Process operation...
 *   }
 */
class InstructionDecoder {
public:
  InstructionDecoder() = default;
  ~InstructionDecoder() = default;
  
  // Non-copyable (owns intern table state)
  InstructionDecoder(const InstructionDecoder&) = delete;
  InstructionDecoder& operator=(const InstructionDecoder&) = delete;
  
  // Movable
  InstructionDecoder(InstructionDecoder&&) = default;
  InstructionDecoder& operator=(InstructionDecoder&&) = default;
  
  /**
   * Decode batch header (fast path)
   * Only parses header + intern table, does not decode operations
   * 
   * @param data Binary data
   * @param size Data size in bytes
   * @return Decoded header, or nullopt on error
   */
  std::optional<DecodedBatchHeader> decodeHeader(const uint8_t* data, size_t size);
  
  /**
   * Create operation iterator for a decoded batch
   */
  OperationIterator createIterator(const DecodedBatchHeader& header);
  
  /**
   * Decode a single value from binary data
   * Useful for decoding args arrays, etc.
   */
  std::optional<DecodedValue> decodeValue(const uint8_t* data, size_t size, size_t* bytesConsumed = nullptr);
  
  /**
   * Get the intern table (for string resolution)
   */
  const InternTable& getInternTable() const { return internTable_; }
  
  /**
   * Get string from intern table
   */
  std::string_view getString(uint16_t index) const { return internTable_.tryGet(index); }
  
  /**
   * Get last decode error
   */
  DecodeError lastError() const { return lastError_; }
  
  /**
   * Get decoding statistics
   */
  const DecodingStats& getStats() const { return stats_; }
  
  /**
   * Reset decoder state (clear intern table, stats)
   */
  void reset();
  
  /**
   * Set persistent intern table for cross-batch string reuse
   * When enabled, strings from previous batches remain valid
   */
  void setPersistentIntern(bool enabled) { persistentIntern_ = enabled; }

private:
  InternTable internTable_;
  DecodeError lastError_ = DecodeError::OK;
  DecodingStats stats_;
  bool persistentIntern_ = false;
};

// ============================================
// Inline Implementations
// ============================================

inline std::string_view InternTable::get(uint16_t index) const {
  if (index >= strings_.size()) {
    throw std::out_of_range("Intern index out of bounds: " + std::to_string(index));
  }
  return strings_[index];
}

inline std::string_view InternTable::tryGet(uint16_t index) const noexcept {
  if (index >= strings_.size()) {
    return {};
  }
  return strings_[index];
}

} // namespace rill::protocol
