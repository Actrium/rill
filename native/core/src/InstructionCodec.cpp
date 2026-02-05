/**
 * InstructionCodec.cpp
 *
 * P3-X.6: Optimized Binary Instruction Codec Implementation
 */

#include "InstructionCodec.h"
#include <algorithm>
#include <cstring>

namespace rill::protocol {

// ============================================
// BufferPool Implementation
// ============================================

BufferPool::BufferPool(size_t initialBufferSize, size_t maxPoolSize)
    : initialBufferSize_(initialBufferSize)
    , maxPoolSize_(maxPoolSize) {
  pool_.reserve(maxPoolSize);
}

std::vector<uint8_t> BufferPool::acquire(size_t minSize) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  size_t targetSize = std::max(minSize, initialBufferSize_);
  
  // Find a suitable buffer in the pool
  for (auto it = pool_.begin(); it != pool_.end(); ++it) {
    if (it->capacity() >= targetSize) {
      std::vector<uint8_t> buffer = std::move(*it);
      pool_.erase(it);
      buffer.clear();
      return buffer;
    }
  }
  
  // No suitable buffer, allocate new one
  totalAllocated_++;
  std::vector<uint8_t> buffer;
  buffer.reserve(targetSize);
  return buffer;
}

void BufferPool::release(std::vector<uint8_t>&& buffer) {
  std::lock_guard<std::mutex> lock(mutex_);
  
  if (pool_.size() < maxPoolSize_) {
    buffer.clear();
    pool_.push_back(std::move(buffer));
  }
  // If pool is full, buffer is discarded (freed)
}

size_t BufferPool::poolSize() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return pool_.size();
}

void BufferPool::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  pool_.clear();
}

// ============================================
// PersistentInternManager Implementation
// ============================================

PersistentInternManager::PersistentInternManager(size_t maxStrings)
    : maxStrings_(maxStrings) {
  strings_.reserve(std::min(maxStrings, size_t(1000)));
}

uint16_t PersistentInternManager::intern(const std::string& str) {
  lookupCount_++;

  auto it = indexMap_.find(str);
  if (it != indexMap_.end()) {
    hitCount_++;
    // Touch for LRU: move to back of access order
    auto aoIt = std::find(accessOrder_.begin(), accessOrder_.end(), it->second);
    if (aoIt != accessOrder_.end()) {
      accessOrder_.erase(aoIt);
    }
    accessOrder_.push_back(it->second);
    return it->second;
  }

  // Check if we need to evict (both live strings and tombstones count toward size)
  size_t liveCount = indexMap_.size();
  if (liveCount >= maxStrings_ && freeSlots_.empty()) {
    evictOldest();
  }

  uint16_t index;
  if (!freeSlots_.empty()) {
    // Reuse a tombstone slot — stable index
    index = freeSlots_.back();
    freeSlots_.pop_back();
    strings_[index] = str;
  } else {
    index = static_cast<uint16_t>(strings_.size());
    strings_.push_back(str);
  }
  indexMap_[str] = index;
  accessOrder_.push_back(index);
  return index;
}

void PersistentInternManager::addAt(uint16_t index, std::string_view str) {
  if (index >= maxStrings_) {
    return; // Silently reject — exceeds configured limit
  }

  // Ensure capacity
  if (index >= strings_.size()) {
    strings_.resize(index + 1);
  }

  std::string strCopy(str);
  strings_[index] = strCopy;
  indexMap_[strCopy] = index;
}

std::vector<std::string_view> PersistentInternManager::getNewStrings() const {
  std::vector<std::string_view> result;
  result.reserve(strings_.size() - markIndex_);
  
  for (size_t i = markIndex_; i < strings_.size(); ++i) {
    result.emplace_back(strings_[i]);
  }
  
  return result;
}

void PersistentInternManager::clear() {
  strings_.clear();
  indexMap_.clear();
  markIndex_ = 0;
  freeSlots_.clear();
  accessOrder_.clear();
  resetStats();
}

double PersistentInternManager::getHitRate() const {
  return lookupCount_ > 0 
      ? static_cast<double>(hitCount_) / lookupCount_ 
      : 0.0;
}

void PersistentInternManager::resetStats() {
  lookupCount_ = 0;
  hitCount_ = 0;
}

void PersistentInternManager::evictOldest() {
  // LRU tombstone eviction: remove least-recently-used 10% of strings
  // by marking their slots as free (tombstone), preserving all other indices.
  size_t evictCount = std::max(size_t(1), accessOrder_.size() / 10);

  for (size_t i = 0; i < evictCount && !accessOrder_.empty(); ++i) {
    uint16_t victimIndex = accessOrder_.front();
    accessOrder_.erase(accessOrder_.begin());

    // Remove from index map, mark slot as tombstone
    if (victimIndex < strings_.size()) {
      indexMap_.erase(strings_[victimIndex]);
      strings_[victimIndex].clear();  // tombstone: empty string
      freeSlots_.push_back(victimIndex);
    }
  }
}

// ============================================
// InstructionCodec Implementation
// ============================================

InstructionCodec::InstructionCodec(Config config)
    : config_(std::move(config))
    , bufferPool_(config_.initialBufferSize, config_.maxPooledBuffers)
    , internManager_(config_.maxInternStrings) {
  
  // Pre-allocate current buffer
  currentBuffer_.reserve(config_.initialBufferSize);
}

void InstructionCodec::beginEncode(uint32_t batchId) {
  // Get buffer from pool
  currentBuffer_ = bufferPool_.acquire(config_.initialBufferSize);
  currentBuffer_.resize(config_.initialBufferSize);
  
  writePos_ = 0;
  currentBatchId_ = batchId;
  currentOpCount_ = 0;
  
  // Mark intern table position for delta encoding
  if (config_.persistentIntern) {
    internManager_.mark();
  }
  
  // Write header placeholder
  headerPos_ = writePos_;
  writeHeader(batchId, 0, 0);  // opCount will be patched
  
  // Remember where intern table starts
  internTablePos_ = writePos_;
  
  // Write intern table (will be rewritten at finish if delta encoding)
  writeInternTable(config_.deltaEncoding);
}

void InstructionCodec::addCreateOperation(uint32_t nodeId, const std::string& componentType) {
  // CREATE layout: opType(1) + nodeId(4) + typeIndex(2) + propsCount(2) = 9 bytes
  constexpr size_t CREATE_BASE_SIZE = 1 + 4 + 2 + 2;
  if (writePos_ + CREATE_BASE_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  // OpType
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::CREATE);
  
  // NodeId
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  
  // Type index
  uint16_t typeIndex = internString(componentType);
  writeU16LE(currentBuffer_.data() + writePos_, typeIndex);
  writePos_ += 2;
  
  // Props count placeholder (will need separate addProp calls)
  writeU16LE(currentBuffer_.data() + writePos_, 0);
  writePos_ += 2;
  
  currentOpCount_++;
}

void InstructionCodec::addDeleteOperation(uint32_t nodeId) {
  // DELETE layout: opType(1) + nodeId(4) = 5 bytes
  constexpr size_t DELETE_SIZE = 1 + 4;
  if (writePos_ + DELETE_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::DELETE);
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  
  currentOpCount_++;
}

void InstructionCodec::addAppendOperation(uint32_t nodeId, uint32_t parentId, uint32_t childId) {
  // APPEND layout: opType(1) + nodeId(4) + parentId(4) + childId(4) = 13 bytes
  constexpr size_t APPEND_SIZE = 1 + 4 + 4 + 4;
  if (writePos_ + APPEND_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::APPEND);
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, parentId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, childId);
  writePos_ += 4;
  
  currentOpCount_++;
}

void InstructionCodec::addInsertOperation(uint32_t nodeId, uint32_t parentId,
                                          uint32_t childId, uint16_t index) {
  // INSERT layout: opType(1) + nodeId(4) + parentId(4) + childId(4) + index(2) = 15 bytes
  constexpr size_t INSERT_SIZE = 1 + 4 + 4 + 4 + 2;
  if (writePos_ + INSERT_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::INSERT);
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, parentId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, childId);
  writePos_ += 4;
  writeU16LE(currentBuffer_.data() + writePos_, index);
  writePos_ += 2;
  
  currentOpCount_++;
}

void InstructionCodec::addRemoveOperation(uint32_t nodeId, uint32_t parentId, uint32_t childId) {
  // REMOVE layout: opType(1) + nodeId(4) + parentId(4) + childId(4) = 13 bytes
  constexpr size_t REMOVE_SIZE = 1 + 4 + 4 + 4;
  if (writePos_ + REMOVE_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::REMOVE);
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, parentId);
  writePos_ += 4;
  writeU32LE(currentBuffer_.data() + writePos_, childId);
  writePos_ += 4;
  
  currentOpCount_++;
}

void InstructionCodec::addTextOperation(uint32_t nodeId, const std::string& text) {
  // TEXT layout: opType(1) + nodeId(4) + textIndex(2) = 7 bytes
  constexpr size_t TEXT_SIZE = 1 + 4 + 2;
  if (writePos_ + TEXT_SIZE > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() * 2);
  }
  
  currentBuffer_[writePos_++] = static_cast<uint8_t>(OpType::TEXT);
  writeU32LE(currentBuffer_.data() + writePos_, nodeId);
  writePos_ += 4;
  
  uint16_t textIndex = internString(text);
  writeU16LE(currentBuffer_.data() + writePos_, textIndex);
  writePos_ += 2;
  
  currentOpCount_++;
}

std::vector<uint8_t> InstructionCodec::finishEncode() {
  auto startTime = std::chrono::high_resolution_clock::now();
  
  // Patch header with actual op count
  patchHeader(currentOpCount_);
  
  // If delta encoding, rewrite intern table with only new strings
  if (config_.deltaEncoding) {
    // For now, keep full table - delta encoding requires protocol support
  }
  
  // Trim buffer to actual size
  currentBuffer_.resize(writePos_);
  
  auto endTime = std::chrono::high_resolution_clock::now();
  double encodingMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
  
  // Update stats
  if (config_.collectStats) {
    std::lock_guard<std::mutex> lock(statsMutex_);
    stats_.batchesEncoded++;
    stats_.operationsEncoded += currentOpCount_;
    stats_.bytesEncoded += writePos_;
    stats_.totalEncodingMs += encodingMs;
    stats_.avgEncodingMs = stats_.totalEncodingMs / stats_.batchesEncoded;
    stats_.internTableSize = internManager_.size();
    stats_.internHitRate = internManager_.getHitRate();
    stats_.bufferPoolSize = bufferPool_.poolSize();
    stats_.buffersAllocated = bufferPool_.totalAllocated();
  }
  
  // Move buffer out (will be returned to pool by caller or via RAII)
  return std::move(currentBuffer_);
}

std::optional<DecodedBatchHeader> InstructionCodec::decodeHeader(
    const uint8_t* data, size_t size) {
  
  auto startTime = std::chrono::high_resolution_clock::now();
  
  // Use internal decoder with persistent intern
  decoder_.setPersistentIntern(config_.persistentIntern);
  auto header = decoder_.decodeHeader(data, size);
  
  auto endTime = std::chrono::high_resolution_clock::now();
  double decodingMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
  
  if (header && config_.collectStats) {
    std::lock_guard<std::mutex> lock(statsMutex_);
    stats_.batchesDecoded++;
    stats_.bytesDecoded += size;
    stats_.totalDecodingMs += decodingMs;
    stats_.avgDecodingMs = stats_.totalDecodingMs / stats_.batchesDecoded;
  }
  
  return header;
}

OperationIterator InstructionCodec::createIterator(const DecodedBatchHeader& header) {
  return decoder_.createIterator(header);
}

std::string_view InstructionCodec::getString(uint16_t index) const {
  return decoder_.getString(index);
}

void InstructionCodec::reset() {
  internManager_.clear();
  decoder_.reset();
  bufferPool_.clear();
  
  std::lock_guard<std::mutex> lock(statsMutex_);
  stats_.reset();
}

void InstructionCodec::syncInternTable(const std::vector<std::string>& newStrings) {
  for (const auto& str : newStrings) {
    internManager_.intern(str);
  }
}

CodecStats InstructionCodec::getStats() const {
  std::lock_guard<std::mutex> lock(statsMutex_);
  return stats_;
}

double InstructionCodec::getInternHitRate() const {
  return internManager_.getHitRate();
}

// ============================================
// Private Methods
// ============================================

void InstructionCodec::writeHeader(uint32_t batchId, uint16_t opCount, uint8_t flags) {
  // Ensure capacity
  if (writePos_ + 16 > currentBuffer_.size()) {
    currentBuffer_.resize(currentBuffer_.size() + 16);
  }
  
  writeU32LE(currentBuffer_.data() + writePos_, RILL_MAGIC);
  writePos_ += 4;
  
  writeU16LE(currentBuffer_.data() + writePos_, PROTOCOL_VERSION);
  writePos_ += 2;
  
  writeU32LE(currentBuffer_.data() + writePos_, batchId);
  writePos_ += 4;
  
  writeU16LE(currentBuffer_.data() + writePos_, opCount);
  writePos_ += 2;
  
  currentBuffer_[writePos_++] = flags;
  currentBuffer_[writePos_++] = 0;  // reserved[0]
  currentBuffer_[writePos_++] = 0;  // reserved[1]
  currentBuffer_[writePos_++] = 0;  // reserved[2]
}

void InstructionCodec::writeInternTable(bool deltaOnly) {
  auto strings = deltaOnly 
      ? internManager_.getNewStrings()
      : std::vector<std::string_view>();
  
  if (!deltaOnly) {
    // Write all strings
    size_t count = internManager_.size();
    
    // Ensure capacity for count
    if (writePos_ + 2 > currentBuffer_.size()) {
      currentBuffer_.resize(currentBuffer_.size() * 2);
    }
    
    writeU16LE(currentBuffer_.data() + writePos_, static_cast<uint16_t>(count));
    writePos_ += 2;
    
    for (size_t i = 0; i < count; ++i) {
      std::string_view str = internManager_.get(static_cast<uint16_t>(i));
      
      // Ensure capacity
      if (writePos_ + 2 + str.size() > currentBuffer_.size()) {
        currentBuffer_.resize(currentBuffer_.size() * 2 + str.size());
      }
      
      writeU16LE(currentBuffer_.data() + writePos_, static_cast<uint16_t>(str.size()));
      writePos_ += 2;
      
      std::memcpy(currentBuffer_.data() + writePos_, str.data(), str.size());
      writePos_ += str.size();
    }
  } else {
    // Write only new strings since mark
    if (writePos_ + 2 > currentBuffer_.size()) {
      currentBuffer_.resize(currentBuffer_.size() * 2);
    }
    
    writeU16LE(currentBuffer_.data() + writePos_, static_cast<uint16_t>(strings.size()));
    writePos_ += 2;
    
    for (const auto& str : strings) {
      if (writePos_ + 2 + str.size() > currentBuffer_.size()) {
        currentBuffer_.resize(currentBuffer_.size() * 2 + str.size());
      }
      
      writeU16LE(currentBuffer_.data() + writePos_, static_cast<uint16_t>(str.size()));
      writePos_ += 2;
      
      std::memcpy(currentBuffer_.data() + writePos_, str.data(), str.size());
      writePos_ += str.size();
    }
  }
}

void InstructionCodec::patchHeader(uint16_t opCount) {
  writeU16LE(currentBuffer_.data() + headerPos_ + 10, opCount);
}

uint16_t InstructionCodec::internString(const std::string& str) {
  return internManager_.intern(str);
}

} // namespace rill::protocol
