/**
 * InstructionEncoder.h
 *
 * P3-X.4: Binary Instruction Encoder
 *
 * Encodes JSI values and operation batches into binary format.
 * Used for Host→Guest direction (events, config updates).
 * 
 * Features:
 *   - String interning with persistent table
 *   - Buffer reuse to minimize allocations
 *   - Efficient encoding of common value patterns
 */

#pragma once

#include "InstructionFormat.h"

#include <string>
#include <vector>
#include <unordered_map>

// Forward declaration for JSI types (avoid full include)
namespace facebook::jsi {
class Runtime;
class Value;
class Object;
class Array;
class String;
} // namespace facebook::jsi

namespace rill::protocol {

// ============================================
// Encoder Configuration
// ============================================

struct EncoderConfig {
  // Initial buffer size (will grow if needed)
  size_t initialBufferSize = 4096;
  
  // Maximum buffer size (prevents runaway growth)
  size_t maxBufferSize = 16 * 1024 * 1024; // 16MB
  
  // Whether to persist intern table across batches
  bool persistentIntern = true;
  
  // Maximum strings in intern table (after which oldest are evicted)
  size_t maxInternStrings = 10000;
  
  // Include timestamps in operations
  bool includeTimestamps = false;
};

// ============================================
// String Intern Pool (Encoder side)
// ============================================

/**
 * String interning pool for encoding
 * Tracks strings and assigns u16 indices
 */
class InternPool {
public:
  InternPool() = default;
  
  /**
   * Get or create intern index for string
   * @return Index in intern table
   */
  uint16_t intern(const std::string& str);
  
  /**
   * Check if string is already interned
   */
  bool has(const std::string& str) const;
  
  /**
   * Get index for already-interned string
   * @return Index, or MAX_INTERN_STRINGS if not found
   */
  uint16_t getIndex(const std::string& str) const;
  
  /**
   * Get string at index
   */
  const std::string& getString(uint16_t index) const;
  
  /**
   * Number of interned strings
   */
  size_t size() const { return strings_.size(); }
  
  /**
   * Clear intern pool
   */
  void clear();
  
  /**
   * Get all strings (for serialization)
   */
  const std::vector<std::string>& getStrings() const { return strings_; }
  
  /**
   * Get new strings since last mark
   * Used for delta encoding
   */
  std::vector<std::string> getNewStrings(size_t sinceIndex) const;
  
  /**
   * Mark current position for delta tracking
   */
  void mark() { markIndex_ = strings_.size(); }
  
  /**
   * Get mark position
   */
  size_t getMarkIndex() const { return markIndex_; }

private:
  std::vector<std::string> strings_;
  std::unordered_map<std::string, uint16_t> indexMap_;
  size_t markIndex_ = 0;
};

// ============================================
// Buffer Writer
// ============================================

/**
 * Growable buffer for binary encoding
 */
class BufferWriter {
public:
  explicit BufferWriter(size_t initialCapacity = 4096);
  
  // Write primitives
  void writeU8(uint8_t value);
  void writeU16(uint16_t value);
  void writeU32(uint32_t value);
  void writeU64(uint64_t value);
  void writeI32(int32_t value);
  void writeF64(double value);
  
  // Write raw bytes
  void writeBytes(const void* data, size_t size);
  void writeString(const std::string& str);
  
  // Position management
  size_t position() const { return position_; }
  void setPosition(size_t pos) { position_ = pos; }
  void reserve(size_t additionalBytes);
  
  // Get result
  const uint8_t* data() const { return buffer_.data(); }
  size_t size() const { return position_; }
  
  // Extract buffer (moves ownership)
  std::vector<uint8_t> extract();
  
  // Reset for reuse
  void reset();

private:
  void ensureCapacity(size_t needed);
  
  std::vector<uint8_t> buffer_;
  size_t position_ = 0;
};

// ============================================
// Instruction Encoder
// ============================================

/**
 * Binary instruction batch encoder
 *
 * Usage with JSI:
 *   InstructionEncoder encoder;
 *   auto binary = encoder.encodeBatch(runtime, batchObject);
 *   
 * Usage without JSI (raw operations):
 *   encoder.beginBatch(batchId);
 *   encoder.writeCreateOp(nodeId, "View", props);
 *   encoder.writeAppendOp(nodeId, parentId, childId);
 *   auto binary = encoder.finishBatch();
 */
class InstructionEncoder {
public:
  explicit InstructionEncoder(EncoderConfig config = {});
  ~InstructionEncoder() = default;
  
  // Non-copyable
  InstructionEncoder(const InstructionEncoder&) = delete;
  InstructionEncoder& operator=(const InstructionEncoder&) = delete;
  
  // Movable
  InstructionEncoder(InstructionEncoder&&) = default;
  InstructionEncoder& operator=(InstructionEncoder&&) = default;
  
  // ============================================
  // High-level JSI encoding
  // ============================================
  
  /**
   * Encode a complete batch from JSI object
   * 
   * Expected object format (matches SerializedOperationBatch):
   * {
   *   version: number,
   *   batchId: number,
   *   operations: Array<SerializedOperation>
   * }
   */
  std::vector<uint8_t> encodeBatch(facebook::jsi::Runtime& rt,
                                   const facebook::jsi::Object& batch);
  
  /**
   * Encode a single JSI value
   */
  void encodeValue(facebook::jsi::Runtime& rt,
                   const facebook::jsi::Value& value);
  
  // ============================================
  // Low-level batch building (without JSI)
  // ============================================
  
  /**
   * Begin a new batch
   */
  void beginBatch(uint32_t batchId, uint8_t flags = BatchFlags::NONE);
  
  /**
   * Finish batch and return binary data
   */
  std::vector<uint8_t> finishBatch();
  
  // ============================================
  // Operation writers
  // ============================================
  
  /**
   * Write CREATE operation
   * @param nodeId Node ID
   * @param type Component type name
   * @param props Property key-value pairs
   */
  void writeCreateOp(uint32_t nodeId, const std::string& type,
                     const std::vector<std::pair<std::string, std::string>>& props = {});
  
  /**
   * Write UPDATE operation
   */
  void writeUpdateOp(uint32_t nodeId,
                     const std::vector<std::pair<std::string, std::string>>& props,
                     const std::vector<std::string>& removedProps = {});
  
  /**
   * Write DELETE operation
   */
  void writeDeleteOp(uint32_t nodeId);
  
  /**
   * Write APPEND operation
   */
  void writeAppendOp(uint32_t nodeId, uint32_t parentId, uint32_t childId);
  
  /**
   * Write INSERT operation
   */
  void writeInsertOp(uint32_t nodeId, uint32_t parentId, uint32_t childId, uint16_t index);
  
  /**
   * Write REMOVE operation
   */
  void writeRemoveOp(uint32_t nodeId, uint32_t parentId, uint32_t childId);
  
  /**
   * Write REORDER operation
   */
  void writeReorderOp(uint32_t nodeId, uint32_t parentId, 
                      const std::vector<uint32_t>& childIds);
  
  /**
   * Write TEXT operation
   */
  void writeTextOp(uint32_t nodeId, const std::string& text);
  
  /**
   * Write REF_CALL operation
   */
  void writeRefCallOp(uint32_t nodeId, const std::string& method,
                      const std::string& callId,
                      const std::vector<std::string>& argsJson = {});
  
  // ============================================
  // Value writers
  // ============================================
  
  void writeNull();
  void writeUndefined();
  void writeBool(bool value);
  void writeInt32(int32_t value);
  void writeFloat64(double value);
  void writeString(const std::string& str);
  void writeFunction(const std::string& fnId);
  void writeDate(double timestamp);
  
  // ============================================
  // Statistics & State
  // ============================================
  
  /**
   * Get encoding statistics from last batch
   */
  const EncodingStats& getStats() const { return stats_; }
  
  /**
   * Get current operation count in batch
   */
  uint16_t getOperationCount() const { return opCount_; }
  
  /**
   * Clear intern pool (for testing or memory management)
   */
  void clearInternPool() { internPool_.clear(); }
  
  /**
   * Get intern pool size
   */
  size_t getInternPoolSize() const { return internPool_.size(); }

private:
  // Centralize intern + stats counting (total string references in the encoded ops).
  uint16_t internString(const std::string& str);

  // JSI encoding helpers
  void encodeJSIValue(facebook::jsi::Runtime& rt, const facebook::jsi::Value& value);
  void encodeJSIObject(facebook::jsi::Runtime& rt, const facebook::jsi::Object& obj);
  void encodeJSIArray(facebook::jsi::Runtime& rt, const facebook::jsi::Array& arr);
  void encodeJSIOperation(facebook::jsi::Runtime& rt, const facebook::jsi::Object& op);
  void encodeJSIProps(facebook::jsi::Runtime& rt, const facebook::jsi::Object& props);
  
  // Batch finalization
  void writeHeader();
  void writeInternTable();
  void patchHeader();
  
  // Configuration
  EncoderConfig config_;
  
  // State
  BufferWriter buffer_;
  BufferWriter opsBuffer_;  // Temporary buffer for operations
  InternPool internPool_;
  uint32_t currentBatchId_ = 0;
  uint8_t currentFlags_ = 0;
  uint16_t opCount_ = 0;
  size_t internStartIndex_ = 0;  // For delta encoding
  
  // Statistics
  EncodingStats stats_;
};

// ============================================
// Inline Implementations
// ============================================

inline void BufferWriter::writeU8(uint8_t value) {
  ensureCapacity(1);
  buffer_[position_++] = value;
}

inline void BufferWriter::writeU16(uint16_t value) {
  ensureCapacity(2);
  writeU16LE(buffer_.data() + position_, value);
  position_ += 2;
}

inline void BufferWriter::writeU32(uint32_t value) {
  ensureCapacity(4);
  writeU32LE(buffer_.data() + position_, value);
  position_ += 4;
}

inline void BufferWriter::writeU64(uint64_t value) {
  ensureCapacity(8);
  writeU64LE(buffer_.data() + position_, value);
  position_ += 8;
}

inline void BufferWriter::writeI32(int32_t value) {
  writeU32(static_cast<uint32_t>(value));
}

inline void BufferWriter::writeF64(double value) {
  ensureCapacity(8);
  writeF64LE(buffer_.data() + position_, value);
  position_ += 8;
}

} // namespace rill::protocol
