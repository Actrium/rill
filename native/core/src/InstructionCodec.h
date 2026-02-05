/**
 * InstructionCodec.h
 *
 * P3-X.6: Optimized Binary Instruction Codec
 *
 * High-performance codec with:
 *   - Cross-batch string intern persistence
 *   - Buffer pooling and reuse
 *   - Delta encoding for intern tables
 *   - Zero-allocation fast path
 *
 * Usage:
 *   // Create codec with persistent state
 *   InstructionCodec codec;
 *   
 *   // Encode multiple batches (strings persist)
 *   auto binary1 = codec.encode(batch1);
 *   auto binary2 = codec.encode(batch2); // Reuses intern table
 *   
 *   // Decode with shared state
 *   auto decoded1 = codec.decode(binary1);
 *   auto decoded2 = codec.decode(binary2);
 */

#pragma once

#include "InstructionFormat.h"
#include "InstructionEncoder.h"
#include "InstructionDecoder.h"

#include <memory>
#include <vector>
#include <unordered_map>
#include <chrono>

namespace rill::protocol {

// ============================================
// Buffer Pool
// ============================================

/**
 * Pool of reusable buffers to minimize allocations
 */
class BufferPool {
public:
  explicit BufferPool(size_t initialBufferSize = 8192, size_t maxPoolSize = 8);
  ~BufferPool() = default;
  
  /**
   * Acquire a buffer from the pool
   * @return Buffer with at least minSize capacity
   */
  std::vector<uint8_t> acquire(size_t minSize = 0);
  
  /**
   * Return a buffer to the pool
   */
  void release(std::vector<uint8_t>&& buffer);
  
  /**
   * Get current pool size
   */
  size_t poolSize() const;
  
  /**
   * Get total buffers allocated (including those in use)
   */
  size_t totalAllocated() const { return totalAllocated_; }
  
  /**
   * Clear all pooled buffers
   */
  void clear();

private:
  std::vector<std::vector<uint8_t>> pool_;
  size_t initialBufferSize_;
  size_t maxPoolSize_;
  size_t totalAllocated_ = 0;
  mutable std::mutex mutex_;
};

// ============================================
// Persistent Intern Manager
// ============================================

/**
 * Manages string interning across multiple batches
 * 
 * Supports:
 *   - LRU eviction for memory management
 *   - Delta encoding (only send new strings)
 *   - Bidirectional sync between encoder/decoder
 */
class PersistentInternManager {
public:
  explicit PersistentInternManager(size_t maxStrings = 10000);
  ~PersistentInternManager() = default;
  
  /**
   * Get or create index for string (encoder side)
   * @return Index in intern table
   */
  uint16_t intern(const std::string& str);
  
  /**
   * Add string at specific index (decoder side)
   */
  void addAt(uint16_t index, std::string_view str);
  
  /**
   * Get string by index
   */
  std::string_view get(uint16_t index) const;
  
  /**
   * Check if string is already interned
   */
  bool has(const std::string& str) const;
  
  /**
   * Get index for string, or MAX_INTERN_STRINGS if not found
   */
  uint16_t getIndex(const std::string& str) const;
  
  /**
   * Get number of strings
   */
  size_t size() const { return strings_.size(); }
  
  /**
   * Mark position for delta encoding
   */
  void mark() { markIndex_ = strings_.size(); }
  
  /**
   * Get mark position
   */
  size_t getMarkIndex() const { return markIndex_; }
  
  /**
   * Get strings added since mark
   */
  std::vector<std::string_view> getNewStrings() const;
  
  /**
   * Clear all strings
   */
  void clear();
  
  /**
   * Get hit rate (reused / total lookups)
   */
  double getHitRate() const;
  
  /**
   * Reset statistics
   */
  void resetStats();

private:
  void evictOldest();

  std::vector<std::string> strings_;
  std::unordered_map<std::string, uint16_t> indexMap_;
  size_t maxStrings_;
  size_t markIndex_ = 0;

  // Tombstone tracking: free slots from evicted strings (stable indices)
  std::vector<uint16_t> freeSlots_;
  // Access order tracking for LRU eviction (most-recent at back)
  std::vector<uint16_t> accessOrder_;

  // Statistics
  mutable size_t lookupCount_ = 0;
  mutable size_t hitCount_ = 0;
};

// ============================================
// Codec Statistics
// ============================================

/**
 * Accumulated codec statistics
 */
struct CodecStats {
  // Encoding stats
  uint64_t batchesEncoded = 0;
  uint64_t operationsEncoded = 0;
  uint64_t bytesEncoded = 0;
  double totalEncodingMs = 0.0;
  double avgEncodingMs = 0.0;
  
  // Decoding stats
  uint64_t batchesDecoded = 0;
  uint64_t operationsDecoded = 0;
  uint64_t bytesDecoded = 0;
  double totalDecodingMs = 0.0;
  double avgDecodingMs = 0.0;
  
  // Intern stats
  size_t internTableSize = 0;
  double internHitRate = 0.0;
  
  // Buffer pool stats
  size_t bufferPoolSize = 0;
  size_t buffersAllocated = 0;
  
  /**
   * Reset all statistics
   */
  void reset() {
    *this = CodecStats{};
  }
};

// ============================================
// Instruction Codec
// ============================================

/**
 * High-performance binary instruction codec
 * 
 * Features:
 *   - Persistent intern table across batches
 *   - Buffer pooling
 *   - Delta encoding support
 *   - Thread-safe
 */
class InstructionCodec {
public:
  /**
   * Codec configuration
   */
  struct Config {
    // Buffer pool settings
    size_t initialBufferSize;
    size_t maxPooledBuffers;
    
    // Intern table settings
    size_t maxInternStrings;
    bool persistentIntern;
    bool deltaEncoding;  // Send only new strings
    
    // Timing
    bool includeTimestamps;
    
    // Debug
    bool collectStats;
    
    Config()
        : initialBufferSize(8192)
        , maxPooledBuffers(8)
        , maxInternStrings(10000)
        , persistentIntern(true)
        , deltaEncoding(false)
        , includeTimestamps(false)
        , collectStats(true) {}
  };
  
  explicit InstructionCodec(Config config = Config());
  ~InstructionCodec() = default;
  
  // Non-copyable
  InstructionCodec(const InstructionCodec&) = delete;
  InstructionCodec& operator=(const InstructionCodec&) = delete;
  
  // ============================================
  // Encoding
  // ============================================
  
  /**
   * Encode operations to binary format
   * 
   * @param batchId Batch identifier
   * @param operations Vector of operation data
   * @return Binary encoded data
   */
  std::vector<uint8_t> encode(uint32_t batchId,
                              const std::vector<std::pair<OpType, std::vector<uint8_t>>>& operations);
  
  /**
   * Begin incremental encoding
   */
  void beginEncode(uint32_t batchId);
  
  /**
   * Add operation to current batch
   */
  void addOperation(OpType type, uint32_t nodeId);
  void addCreateOperation(uint32_t nodeId, const std::string& componentType);
  void addUpdateOperation(uint32_t nodeId);
  void addDeleteOperation(uint32_t nodeId);
  void addAppendOperation(uint32_t nodeId, uint32_t parentId, uint32_t childId);
  void addInsertOperation(uint32_t nodeId, uint32_t parentId, uint32_t childId, uint16_t index);
  void addRemoveOperation(uint32_t nodeId, uint32_t parentId, uint32_t childId);
  void addTextOperation(uint32_t nodeId, const std::string& text);
  
  /**
   * Add property to current operation
   */
  void addProp(const std::string& key, const std::string& value);
  void addPropInt(const std::string& key, int32_t value);
  void addPropFloat(const std::string& key, double value);
  void addPropBool(const std::string& key, bool value);
  void addPropNull(const std::string& key);
  void addPropFunction(const std::string& key, const std::string& fnId);
  
  /**
   * Finish encoding and return binary data
   */
  std::vector<uint8_t> finishEncode();
  
  // ============================================
  // Decoding
  // ============================================
  
  /**
   * Decode binary data to batch header (fast path)
   */
  std::optional<DecodedBatchHeader> decodeHeader(const uint8_t* data, size_t size);
  
  /**
   * Create iterator for operations
   */
  OperationIterator createIterator(const DecodedBatchHeader& header);
  
  /**
   * Get string from intern table
   */
  std::string_view getString(uint16_t index) const;
  
  // ============================================
  // State Management
  // ============================================
  
  /**
   * Reset codec state (clear intern table, stats)
   */
  void reset();
  
  /**
   * Sync intern table with remote peer
   * Call after receiving delta-encoded batch
   */
  void syncInternTable(const std::vector<std::string>& newStrings);
  
  /**
   * Get current statistics
   */
  CodecStats getStats() const;
  
  /**
   * Get intern table hit rate
   */
  double getInternHitRate() const;

private:
  void writeHeader(uint32_t batchId, uint16_t opCount, uint8_t flags);
  void writeInternTable(bool deltaOnly);
  void patchHeader(uint16_t opCount);
  uint16_t internString(const std::string& str);
  
  Config config_;
  
  // Buffer management
  BufferPool bufferPool_;
  std::vector<uint8_t> currentBuffer_;
  size_t writePos_ = 0;
  
  // Intern table
  PersistentInternManager internManager_;
  
  // Current batch state
  uint32_t currentBatchId_ = 0;
  uint16_t currentOpCount_ = 0;
  size_t headerPos_ = 0;
  size_t internTablePos_ = 0;
  
  // Decoder state
  InstructionDecoder decoder_;
  
  // Statistics
  CodecStats stats_;
  mutable std::mutex statsMutex_;
};

// ============================================
// Inline Implementations
// ============================================

inline std::string_view PersistentInternManager::get(uint16_t index) const {
  if (index >= strings_.size()) {
    return {};
  }
  return strings_[index];
}

inline bool PersistentInternManager::has(const std::string& str) const {
  return indexMap_.find(str) != indexMap_.end();
}

inline uint16_t PersistentInternManager::getIndex(const std::string& str) const {
  auto it = indexMap_.find(str);
  return it != indexMap_.end() ? it->second : MAX_INTERN_STRINGS;
}

} // namespace rill::protocol
