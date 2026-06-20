/**
 * InstructionEncoder.cpp
 *
 * P3-X.4: Binary Instruction Encoder Implementation
 */

#include "InstructionEncoder.h"
#include <chrono>
#include <cstring>
#include <stdexcept>

// JSI includes (conditional for non-JSI builds)
#if __has_include(<jsi/jsi.h>)
#include <jsi/jsi.h>
#define HAS_JSI 1
#else
#define HAS_JSI 0
#endif

namespace rill::protocol {

// ============================================
// InternPool Implementation
// ============================================

uint16_t InternPool::intern(const std::string& str) {
  auto it = indexMap_.find(str);
  if (it != indexMap_.end()) {
    return it->second;
  }
  
  if (strings_.size() >= MAX_INTERN_STRINGS) {
    throw std::runtime_error("Intern pool overflow");
  }
  
  uint16_t index = static_cast<uint16_t>(strings_.size());
  strings_.push_back(str);
  indexMap_[str] = index;
  return index;
}

bool InternPool::has(const std::string& str) const {
  return indexMap_.find(str) != indexMap_.end();
}

uint16_t InternPool::getIndex(const std::string& str) const {
  auto it = indexMap_.find(str);
  return it != indexMap_.end() ? it->second : MAX_INTERN_STRINGS;
}

const std::string& InternPool::getString(uint16_t index) const {
  if (index >= strings_.size()) {
    throw std::out_of_range("Intern index out of bounds");
  }
  return strings_[index];
}

void InternPool::clear() {
  strings_.clear();
  indexMap_.clear();
  markIndex_ = 0;
}

std::vector<std::string> InternPool::getNewStrings(size_t sinceIndex) const {
  if (sinceIndex >= strings_.size()) {
    return {};
  }
  return std::vector<std::string>(strings_.begin() + sinceIndex, strings_.end());
}

// ============================================
// BufferWriter Implementation
// ============================================

BufferWriter::BufferWriter(size_t initialCapacity) {
  buffer_.reserve(initialCapacity);
  buffer_.resize(initialCapacity);
}

void BufferWriter::writeBytes(const void* data, size_t size) {
  ensureCapacity(size);
  std::memcpy(buffer_.data() + position_, data, size);
  position_ += size;
}

void BufferWriter::writeString(const std::string& str) {
  writeBytes(str.data(), str.size());
}

void BufferWriter::reserve(size_t additionalBytes) {
  ensureCapacity(additionalBytes);
}

std::vector<uint8_t> BufferWriter::extract() {
  buffer_.resize(position_);
  auto result = std::move(buffer_);
  buffer_ = std::vector<uint8_t>();
  position_ = 0;
  return result;
}

void BufferWriter::reset() {
  position_ = 0;
}

void BufferWriter::ensureCapacity(size_t needed) {
  size_t required = position_ + needed;
  if (required <= buffer_.size()) {
    return;
  }
  
  // Grow by doubling
  size_t newSize = buffer_.size() > 0 ? buffer_.size() * 2 : size_t(1);
  while (newSize < required) {
    newSize *= 2;
  }
  
  buffer_.resize(newSize);
}

// ============================================
// InstructionEncoder Implementation
// ============================================

InstructionEncoder::InstructionEncoder(EncoderConfig config)
    : config_(std::move(config))
    , buffer_(config_.initialBufferSize)
    , opsBuffer_(config_.initialBufferSize) {}

uint16_t InstructionEncoder::internString(const std::string& str) {
  // Count all string references (including reuses) for interning stats.
  stats_.totalStringsEncoded++;
  return internPool_.intern(str);
}

void InstructionEncoder::beginBatch(uint32_t batchId, uint8_t flags) {
  currentBatchId_ = batchId;
  currentFlags_ = flags;
  opCount_ = 0;
  
  buffer_.reset();
  opsBuffer_.reset();
  
  // Record starting intern index for delta encoding
  internStartIndex_ = internPool_.size();
  internPool_.mark();
  
  // Reset stats
  stats_ = EncodingStats{};
}

std::vector<uint8_t> InstructionEncoder::finishBatch() {
  auto startTime = std::chrono::high_resolution_clock::now();
  
  // Write header (placeholder, will be patched)
  writeHeader();
  
  // Write intern table
  writeInternTable();
  
  // Copy operations
  buffer_.writeBytes(opsBuffer_.data(), opsBuffer_.size());
  
  // Patch header with final values
  patchHeader();
  
  auto endTime = std::chrono::high_resolution_clock::now();
  stats_.encodingMs = std::chrono::duration<double, std::milli>(
      endTime - startTime).count();
  stats_.outputBytes = buffer_.size();
  stats_.operationCount = opCount_;
  stats_.internedStrings = static_cast<uint32_t>(internPool_.size() - internStartIndex_);
  
  // Clear intern pool if not persistent
  if (!config_.persistentIntern) {
    internPool_.clear();
  }
  
  return buffer_.extract();
}

void InstructionEncoder::writeHeader() {
  buffer_.writeU32(RILL_MAGIC);
  buffer_.writeU16(PROTOCOL_VERSION);
  buffer_.writeU32(currentBatchId_);
  buffer_.writeU16(opCount_);  // Will be patched
  buffer_.writeU8(currentFlags_);
  buffer_.writeU8(0);  // reserved[0]
  buffer_.writeU8(0);  // reserved[1]
  buffer_.writeU8(0);  // reserved[2]
}

void InstructionEncoder::writeInternTable() {
  // For delta encoding, only write new strings
  size_t startIndex = (currentFlags_ & BatchFlags::DELTA_INTERN) 
                        ? internStartIndex_ : 0;
  
  auto newStrings = internPool_.getNewStrings(startIndex);
  
  buffer_.writeU16(static_cast<uint16_t>(newStrings.size()));
  
  for (const auto& str : newStrings) {
    if (str.size() > MAX_STRING_LENGTH) {
      throw std::runtime_error("String too long for intern table");
    }
    buffer_.writeU16(static_cast<uint16_t>(str.size()));
    buffer_.writeString(str);
  }
}

void InstructionEncoder::patchHeader() {
  // Patch opCount at offset 10
  uint8_t* data = const_cast<uint8_t*>(buffer_.data());
  writeU16LE(data + 10, opCount_);
}

// ============================================
// Operation Writers
// ============================================

void InstructionEncoder::writeCreateOp(uint32_t nodeId, const std::string& type,
    const std::vector<std::pair<std::string, std::string>>& props) {
  
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::CREATE));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU16(internString(type));
  
  // Write props table
  opsBuffer_.writeU16(static_cast<uint16_t>(props.size()));
  for (const auto& [key, value] : props) {
    opsBuffer_.writeU16(internString(key));
    // For simplicity, treat all values as strings here
    // Real implementation would parse JSON or use typed interface
    opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::STRING));
    opsBuffer_.writeU16(internString(value));
  }
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeUpdateOp(uint32_t nodeId,
    const std::vector<std::pair<std::string, std::string>>& props,
    const std::vector<std::string>& removedProps) {
  
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::UPDATE));
  opsBuffer_.writeU32(nodeId);
  
  // Write props table
  opsBuffer_.writeU16(static_cast<uint16_t>(props.size()));
  for (const auto& [key, value] : props) {
    opsBuffer_.writeU16(internString(key));
    opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::STRING));
    opsBuffer_.writeU16(internString(value));
  }
  
  // Write removed props
  opsBuffer_.writeU16(static_cast<uint16_t>(removedProps.size()));
  for (const auto& prop : removedProps) {
    opsBuffer_.writeU16(internString(prop));
  }
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeDeleteOp(uint32_t nodeId) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::DELETE));
  opsBuffer_.writeU32(nodeId);
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeAppendOp(uint32_t nodeId, uint32_t parentId, uint32_t childId) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::APPEND));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU32(parentId);
  opsBuffer_.writeU32(childId);
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeInsertOp(uint32_t nodeId, uint32_t parentId, 
                                       uint32_t childId, uint16_t index) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::INSERT));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU32(parentId);
  opsBuffer_.writeU32(childId);
  opsBuffer_.writeU16(index);
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeRemoveOp(uint32_t nodeId, uint32_t parentId, uint32_t childId) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::REMOVE));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU32(parentId);
  opsBuffer_.writeU32(childId);
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeReorderOp(uint32_t nodeId, uint32_t parentId,
                                        const std::vector<uint32_t>& childIds) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::REORDER));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU32(parentId);
  opsBuffer_.writeU16(static_cast<uint16_t>(childIds.size()));
  
  for (uint32_t childId : childIds) {
    opsBuffer_.writeU32(childId);
  }
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeTextOp(uint32_t nodeId, const std::string& text) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::TEXT));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU16(internString(text));
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

void InstructionEncoder::writeRefCallOp(uint32_t nodeId, const std::string& method,
                                       const std::string& callId,
                                       const std::vector<std::string>& argsJson) {
  opsBuffer_.writeU8(static_cast<uint8_t>(OpType::REF_CALL));
  opsBuffer_.writeU32(nodeId);
  opsBuffer_.writeU16(internString(method));
  opsBuffer_.writeU16(internString(callId));
  
  // Write args as array of strings (simplified)
  opsBuffer_.writeU16(static_cast<uint16_t>(argsJson.size()));
  for (const auto& arg : argsJson) {
    opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::STRING));
    opsBuffer_.writeU16(internString(arg));
  }
  
  if (config_.includeTimestamps) {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    opsBuffer_.writeU64(static_cast<uint64_t>(ms));
  }
  
  opCount_++;
}

// ============================================
// Value Writers
// ============================================

void InstructionEncoder::writeNull() {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::VNULL));
}

void InstructionEncoder::writeUndefined() {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::UNDEFINED));
}

void InstructionEncoder::writeBool(bool value) {
  opsBuffer_.writeU8(static_cast<uint8_t>(
      value ? ValueType::BOOL_TRUE : ValueType::BOOL_FALSE));
}

void InstructionEncoder::writeInt32(int32_t value) {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::INT32));
  opsBuffer_.writeI32(value);
}

void InstructionEncoder::writeFloat64(double value) {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::FLOAT64));
  opsBuffer_.writeF64(value);
}

void InstructionEncoder::writeString(const std::string& str) {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::STRING));
  opsBuffer_.writeU16(internString(str));
}

void InstructionEncoder::writeFunction(const std::string& fnId) {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::FUNCTION));
  opsBuffer_.writeU16(internString(fnId));
}

void InstructionEncoder::writeDate(double timestamp) {
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::DATE));
  opsBuffer_.writeF64(timestamp);
}

// ============================================
// JSI Encoding (conditional compilation)
// ============================================

#if HAS_JSI

std::vector<uint8_t> InstructionEncoder::encodeBatch(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Object& batch) {
  
  auto startTime = std::chrono::high_resolution_clock::now();
  
  // Get batch metadata
  uint32_t batchId = static_cast<uint32_t>(
      batch.getProperty(rt, "batchId").asNumber());
  
  beginBatch(batchId);
  
  // Get operations array
  auto operations = batch.getProperty(rt, "operations").asObject(rt).asArray(rt);
  size_t opCount = operations.size(rt);
  
  for (size_t i = 0; i < opCount; ++i) {
    auto op = operations.getValueAtIndex(rt, i).asObject(rt);
    encodeJSIOperation(rt, op);
  }
  
  auto result = finishBatch();
  
  auto endTime = std::chrono::high_resolution_clock::now();
  stats_.encodingMs = std::chrono::duration<double, std::milli>(
      endTime - startTime).count();
  
  return result;
}

void InstructionEncoder::encodeJSIOperation(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Object& op) {
  
  auto opType = op.getProperty(rt, "op").asString(rt).utf8(rt);
  auto nodeId = static_cast<uint32_t>(op.getProperty(rt, "id").asNumber());
  
  if (opType == "CREATE") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::CREATE));
    opsBuffer_.writeU32(nodeId);
    
    auto type = op.getProperty(rt, "type").asString(rt).utf8(rt);
    opsBuffer_.writeU16(internString(type));
    
    auto props = op.getProperty(rt, "props").asObject(rt);
    encodeJSIProps(rt, props);
    
  } else if (opType == "UPDATE") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::UPDATE));
    opsBuffer_.writeU32(nodeId);
    
    auto props = op.getProperty(rt, "props").asObject(rt);
    encodeJSIProps(rt, props);
    
    // Removed props
    if (op.hasProperty(rt, "removedProps")) {
      auto removed = op.getProperty(rt, "removedProps").asObject(rt).asArray(rt);
      size_t count = removed.size(rt);
      opsBuffer_.writeU16(static_cast<uint16_t>(count));
      for (size_t i = 0; i < count; ++i) {
        auto propName = removed.getValueAtIndex(rt, i).asString(rt).utf8(rt);
        opsBuffer_.writeU16(internString(propName));
      }
    } else {
      opsBuffer_.writeU16(0);
    }
    
  } else if (opType == "DELETE") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::DELETE));
    opsBuffer_.writeU32(nodeId);
    
  } else if (opType == "APPEND") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::APPEND));
    opsBuffer_.writeU32(nodeId);
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "parentId").asNumber()));
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "childId").asNumber()));
    
  } else if (opType == "INSERT") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::INSERT));
    opsBuffer_.writeU32(nodeId);
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "parentId").asNumber()));
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "childId").asNumber()));
    opsBuffer_.writeU16(static_cast<uint16_t>(op.getProperty(rt, "index").asNumber()));
    
  } else if (opType == "REMOVE") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::REMOVE));
    opsBuffer_.writeU32(nodeId);
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "parentId").asNumber()));
    opsBuffer_.writeU32(static_cast<uint32_t>(op.getProperty(rt, "childId").asNumber()));
    
  } else if (opType == "TEXT") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::TEXT));
    opsBuffer_.writeU32(nodeId);
    auto text = op.getProperty(rt, "text").asString(rt).utf8(rt);
    opsBuffer_.writeU16(internString(text));
    
  } else if (opType == "REF_CALL") {
    opsBuffer_.writeU8(static_cast<uint8_t>(OpType::REF_CALL));
    opsBuffer_.writeU32(nodeId);
    
    auto method = op.getProperty(rt, "method").asString(rt).utf8(rt);
    auto callId = op.getProperty(rt, "callId").asString(rt).utf8(rt);
    opsBuffer_.writeU16(internString(method));
    opsBuffer_.writeU16(internString(callId));
    
    // Args array
    auto args = op.getProperty(rt, "args").asObject(rt).asArray(rt);
    size_t argsCount = args.size(rt);
    opsBuffer_.writeU16(static_cast<uint16_t>(argsCount));
    for (size_t i = 0; i < argsCount; ++i) {
      encodeJSIValue(rt, args.getValueAtIndex(rt, i));
    }
  }
  
  opCount_++;
}

void InstructionEncoder::encodeJSIProps(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Object& props) {
  
  auto names = props.getPropertyNames(rt);
  size_t count = names.size(rt);
  
  opsBuffer_.writeU16(static_cast<uint16_t>(count));
  
  for (size_t i = 0; i < count; ++i) {
    auto name = names.getValueAtIndex(rt, i).asString(rt).utf8(rt);
    opsBuffer_.writeU16(internString(name));
    
    auto value = props.getProperty(rt, name.c_str());
    encodeJSIValue(rt, value);
  }
}

void InstructionEncoder::encodeJSIValue(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Value& value) {
  
  if (value.isNull()) {
    writeNull();
  } else if (value.isUndefined()) {
    writeUndefined();
  } else if (value.isBool()) {
    writeBool(value.getBool());
  } else if (value.isNumber()) {
    double num = value.asNumber();
    // Check if it's an integer
    if (num == static_cast<int32_t>(num) && 
        num >= INT32_MIN && num <= INT32_MAX) {
      writeInt32(static_cast<int32_t>(num));
    } else {
      writeFloat64(num);
    }
  } else if (value.isString()) {
    writeString(value.asString(rt).utf8(rt));
  } else if (value.isObject()) {
    auto obj = value.asObject(rt);
    
    // Check for special serialized types
    if (obj.hasProperty(rt, "__type")) {
      auto type = obj.getProperty(rt, "__type").asString(rt).utf8(rt);
      
      if (type == "function") {
        auto fnId = obj.getProperty(rt, "__fnId").asString(rt).utf8(rt);
        writeFunction(fnId);
      } else if (type == "date") {
        // __value may be a number (ms epoch) or a string (ISO 8601).
        // Try number first; fall back to 0 for unparseable strings.
        auto dateVal = obj.getProperty(rt, "__value");
        double dateMs = 0;
        if (dateVal.isNumber()) {
          dateMs = dateVal.asNumber();
        } else if (dateVal.isString()) {
          try { dateMs = std::stod(dateVal.asString(rt).utf8(rt)); }
          catch (...) { dateMs = 0; }
        }
        opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::DATE));
        opsBuffer_.writeF64(dateMs);
      } else {
        // Unknown special type, encode as object
        encodeJSIObject(rt, obj);
      }
    } else if (obj.isArray(rt)) {
      encodeJSIArray(rt, obj.asArray(rt));
    } else {
      encodeJSIObject(rt, obj);
    }
  }
}

void InstructionEncoder::encodeJSIObject(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Object& obj) {
  
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::OBJECT));
  
  auto names = obj.getPropertyNames(rt);
  size_t count = names.size(rt);
  
  opsBuffer_.writeU16(static_cast<uint16_t>(count));
  
  for (size_t i = 0; i < count; ++i) {
    auto name = names.getValueAtIndex(rt, i).asString(rt).utf8(rt);
    opsBuffer_.writeU16(internString(name));
    
    auto value = obj.getProperty(rt, name.c_str());
    encodeJSIValue(rt, value);
  }
}

void InstructionEncoder::encodeJSIArray(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Array& arr) {
  
  opsBuffer_.writeU8(static_cast<uint8_t>(ValueType::ARRAY));
  
  size_t count = arr.size(rt);
  opsBuffer_.writeU16(static_cast<uint16_t>(count));
  
  for (size_t i = 0; i < count; ++i) {
    encodeJSIValue(rt, arr.getValueAtIndex(rt, i));
  }
}

void InstructionEncoder::encodeValue(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Value& value) {
  encodeJSIValue(rt, value);
}

#else

// Stub implementations when JSI is not available
std::vector<uint8_t> InstructionEncoder::encodeBatch(
    facebook::jsi::Runtime&,
    const facebook::jsi::Object&) {
  throw std::runtime_error("JSI not available");
}

void InstructionEncoder::encodeValue(
    facebook::jsi::Runtime&,
    const facebook::jsi::Value&) {
  throw std::runtime_error("JSI not available");
}

#endif // HAS_JSI

} // namespace rill::protocol
