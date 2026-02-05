/**
 * InstructionDecoder.cpp
 *
 * P3-X.2: Binary Instruction Decoder Implementation
 */

#include "InstructionDecoder.h"
#include <chrono>
#include <cstring>

namespace rill::protocol {

// ============================================
// InternTable Implementation
// ============================================

size_t InternTable::parse(const uint8_t* data, size_t maxSize) {
  if (maxSize < 2) return 0;
  
  uint16_t count = readU16LE(data);
  size_t pos = 2;
  
  strings_.clear();
  strings_.reserve(count);
  
  for (uint16_t i = 0; i < count; ++i) {
    if (pos + 2 > maxSize) return 0;
    
    uint16_t length = readU16LE(data + pos);
    pos += 2;
    
    if (pos + length > maxSize) return 0;
    
    // Create string_view pointing to original buffer (zero-copy)
    strings_.emplace_back(reinterpret_cast<const char*>(data + pos), length);
    pos += length;
  }
  
  return pos;
}

// ============================================
// OperationIterator Implementation
// ============================================

OperationIterator::OperationIterator(const uint8_t* data, size_t size, 
                                     uint16_t count, bool hasTimestamps,
                                     const InternTable* internTable)
    : data_(data)
    , dataSize_(size)
    , totalCount_(count)
    , hasTimestamps_(hasTimestamps)
    , internTable_(internTable) {}

DecodedOperation OperationIterator::next() {
  DecodedOperation op;
  
  if (!hasNext()) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    op.type = OpType::INVALID;
    return op;
  }
  
  size_t consumed = decodeOperation(op);
  if (consumed == 0) {
    op.type = OpType::INVALID;
    return op;
  }
  
  position_ += consumed;
  currentIndex_++;
  return op;
}

bool OperationIterator::skip() {
  if (!hasNext()) return false;
  
  DecodedOperation op;
  size_t consumed = decodeOperation(op);
  if (consumed == 0) return false;
  
  position_ += consumed;
  currentIndex_++;
  return true;
}

size_t OperationIterator::decodeOperation(DecodedOperation& op) {
  if (position_ >= dataSize_) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    return 0;
  }
  
  size_t startPos = position_;
  size_t pos = position_;
  
  // Read opType
  op.type = static_cast<OpType>(data_[pos++]);
  
  // Read nodeId (all ops have this)
  if (pos + 4 > dataSize_) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    return 0;
  }
  op.nodeId = readU32LE(data_ + pos);
  pos += 4;
  
  switch (op.type) {
    case OpType::CREATE: {
      if (pos + 2 > dataSize_) return 0;
      op.create.typeIndex = readU16LE(data_ + pos);
      pos += 2;
      
      size_t propsStart = pos;
      size_t propsBytes = decodePropsTable(pos, op.create.props);
      if (propsBytes == 0) return 0;
      // PropsIterator expects `data` to point to the first entry (after u16 count).
      op.create.props.data = data_ + propsStart + 2;
      op.create.props.dataSize = propsBytes - 2; // Exclude count
      break;
    }
    
    case OpType::UPDATE: {
      size_t propsStart = pos;
      size_t propsBytes = decodePropsTable(pos, op.update.props);
      if (propsBytes == 0) return 0;
      op.update.props.data = data_ + propsStart + 2; // Skip count
      op.update.props.dataSize = propsBytes - 2;
      
      // Read removed props
      if (pos + 2 > dataSize_) return 0;
      op.update.removedCount = readU16LE(data_ + pos);
      pos += 2;
      
      if (pos + op.update.removedCount * 2 > dataSize_) return 0;
      op.update.removedIndicesData = data_ + pos;
      pos += op.update.removedCount * 2;
      break;
    }
    
    case OpType::DELETE: {
      // Only has nodeId, already read
      break;
    }
    
    case OpType::APPEND:
    case OpType::REMOVE: {
      if (pos + 8 > dataSize_) return 0;
      op.tree.parentId = readU32LE(data_ + pos);
      pos += 4;
      op.tree.childId = readU32LE(data_ + pos);
      pos += 4;
      break;
    }
    
    case OpType::INSERT: {
      if (pos + 10 > dataSize_) return 0;
      op.insert.parentId = readU32LE(data_ + pos);
      pos += 4;
      op.insert.childId = readU32LE(data_ + pos);
      pos += 4;
      op.insert.index = readU16LE(data_ + pos);
      pos += 2;
      break;
    }
    
    case OpType::REORDER: {
      if (pos + 6 > dataSize_) return 0;
      op.reorder.parentId = readU32LE(data_ + pos);
      pos += 4;
      op.reorder.childCount = readU16LE(data_ + pos);
      pos += 2;
      
      if (pos + op.reorder.childCount * 4 > dataSize_) return 0;
      op.reorder.childIdsData = data_ + pos;
      pos += op.reorder.childCount * 4;
      break;
    }
    
    case OpType::TEXT: {
      if (pos + 2 > dataSize_) return 0;
      op.text.textIndex = readU16LE(data_ + pos);
      pos += 2;
      break;
    }
    
    case OpType::REF_CALL: {
      if (pos + 4 > dataSize_) return 0;
      op.refCall.methodIndex = readU16LE(data_ + pos);
      pos += 2;
      op.refCall.callIdIndex = readU16LE(data_ + pos);
      pos += 2;
      
      // Read args array (simplified - just store pointer)
      if (pos + 2 > dataSize_) return 0;
      uint16_t argsCount = readU16LE(data_ + pos);
      op.refCall.argsData = data_ + pos;
      
      // Skip args
      pos += 2;
      for (uint16_t i = 0; i < argsCount; ++i) {
        size_t skipped = skipValue(pos);
        if (skipped == 0) return 0;
      }
      op.refCall.argsSize = (data_ + pos) - op.refCall.argsData;
      break;
    }
    
    default:
      lastError_ = DecodeError::INVALID_OP_TYPE;
      return 0;
  }
  
  // Read optional timestamp
  if (hasTimestamps_) {
    if (pos + 8 > dataSize_) return 0;
    op.timestamp = readU64LE(data_ + pos);
    pos += 8;
  }
  
  return pos - startPos;
}

size_t OperationIterator::decodePropsTable(size_t& pos, DecodedPropsTable& props) {
  size_t startPos = pos;
  
  if (pos + 2 > dataSize_) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    return 0;
  }
  
  props.count = readU16LE(data_ + pos);
  pos += 2;
  
  // Skip through props to find total table size.
  for (uint16_t i = 0; i < props.count; ++i) {
    if (pos + 3 > dataSize_) return 0; // keyRef + valueType minimum
    
    pos += 2; // Skip keyRef
    
    if (skipValue(pos) == 0) return 0;
  }
  
  return pos - startPos;
}

size_t OperationIterator::skipValue(size_t& pos) {
  size_t startPos = pos;
  if (pos >= dataSize_) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    return 0;
  }
  
  ValueType type = static_cast<ValueType>(data_[pos++]);

  size_t fixedSize = valueTypeFixedSize(type);
  if (fixedSize > 0) {
    if (pos + fixedSize > dataSize_) {
      lastError_ = DecodeError::TRUNCATED_DATA;
      return 0;
    }
    pos += fixedSize;
    return pos - startPos;
  }
  
  switch (type) {
    case ValueType::VNULL:
    case ValueType::UNDEFINED:
    case ValueType::BOOL_FALSE:
    case ValueType::BOOL_TRUE:
      return pos - startPos;
      
    case ValueType::OBJECT: {
      // Recursively skip props table
      if (pos + 2 > dataSize_) return 0;
      uint16_t count = readU16LE(data_ + pos);
      pos += 2;
      
      for (uint16_t i = 0; i < count; ++i) {
        if (pos + 2 > dataSize_) return 0;
        pos += 2; // Skip keyRef
        
        if (skipValue(pos) == 0) return 0;
      }
      return pos - startPos;
    }
    
    case ValueType::ARRAY: {
      if (pos + 2 > dataSize_) return 0;
      uint16_t count = readU16LE(data_ + pos);
      pos += 2;
      
      for (uint16_t i = 0; i < count; ++i) {
        if (skipValue(pos) == 0) return 0;
      }
      return pos - startPos;
    }
    
    case ValueType::ERROR: {
      // name + message + stack (3 x u16)
      if (pos + 6 > dataSize_) return 0;
      pos += 6;
      return pos - startPos;
    }
    
    case ValueType::REGEXP: {
      // source + flags (2 x u16)
      if (pos + 4 > dataSize_) return 0;
      pos += 4;
      return pos - startPos;
    }
    
    case ValueType::MAP: {
      if (pos + 2 > dataSize_) return 0;
      uint16_t count = readU16LE(data_ + pos);
      pos += 2;
      
      for (uint16_t i = 0; i < count; ++i) {
        // Skip key
        if (skipValue(pos) == 0) return 0;
        
        // Skip value
        if (skipValue(pos) == 0) return 0;
      }
      return pos - startPos;
    }
    
    case ValueType::SET: {
      if (pos + 2 > dataSize_) return 0;
      uint16_t count = readU16LE(data_ + pos);
      pos += 2;
      
      for (uint16_t i = 0; i < count; ++i) {
        if (skipValue(pos) == 0) return 0;
      }
      return pos - startPos;
    }
    
    default:
      lastError_ = DecodeError::INVALID_VALUE_TYPE;
      return 0;
  }
}

// ============================================
// PropsIterator Implementation
// ============================================

PropsIterator::PropsIterator(const DecodedPropsTable& table, const InternTable* internTable)
    : data_(table.data)
    , dataSize_(table.dataSize)
    , totalCount_(table.count)
    , internTable_(internTable) {}

DecodedProp PropsIterator::next() {
  DecodedProp prop;
  
  if (!hasNext() || position_ + 3 > dataSize_) {
    return prop;
  }
  
  // Read key index
  prop.keyIndex = readU16LE(data_ + position_);
  position_ += 2;
  
  // Read value type
  prop.value.type = static_cast<ValueType>(data_[position_++]);
  
  // Read value based on type
  switch (prop.value.type) {
    case ValueType::VNULL:
    case ValueType::UNDEFINED:
      break;
      
    case ValueType::BOOL_FALSE:
      prop.value.boolValue = false;
      break;
      
    case ValueType::BOOL_TRUE:
      prop.value.boolValue = true;
      break;
      
    case ValueType::INT32:
      if (position_ + 4 <= dataSize_) {
        prop.value.int32Value = static_cast<int32_t>(readU32LE(data_ + position_));
        position_ += 4;
      }
      break;
      
    case ValueType::FLOAT64:
      if (position_ + 8 <= dataSize_) {
        prop.value.float64Value = readF64LE(data_ + position_);
        position_ += 8;
      }
      break;
      
    case ValueType::STRING:
    case ValueType::FUNCTION:
    case ValueType::PROMISE:
      if (position_ + 2 <= dataSize_) {
        prop.value.internIndex = readU16LE(data_ + position_);
        position_ += 2;
      }
      break;
      
    case ValueType::DATE:
      if (position_ + 8 <= dataSize_) {
        prop.value.float64Value = readF64LE(data_ + position_);
        position_ += 8;
      }
      break;
      
    case ValueType::OBJECT: {
      // Store pointer for lazy decoding, then skip past the nested data.
      prop.value.compoundData = data_ + position_;
      // Object layout: u16 count + [u16 keyRef, value]...
      if (position_ + 2 > dataSize_) break;
      uint16_t objCount = readU16LE(data_ + position_);
      size_t scanPos = position_;
      scanPos += 2;
      for (uint16_t j = 0; j < objCount; ++j) {
        if (scanPos + 2 > dataSize_) break;
        scanPos += 2; // keyRef
        // Skip the value by walking its type tag + payload
        if (scanPos >= dataSize_) break;
        ValueType vt = static_cast<ValueType>(data_[scanPos]);
        size_t fixed = valueTypeFixedSize(vt);
        scanPos += 1; // type byte
        if (fixed > 0) {
          scanPos += fixed;
        } else if (vt == ValueType::VNULL || vt == ValueType::UNDEFINED ||
                   vt == ValueType::BOOL_FALSE || vt == ValueType::BOOL_TRUE) {
          // no payload
        } else {
          // Nested compound — for safety just stop lazy decode here
          break;
        }
      }
      prop.value.compoundSize = scanPos - position_;
      position_ = scanPos;
      break;
    }

    case ValueType::ARRAY: {
      prop.value.compoundData = data_ + position_;
      // Array layout: u16 count + [value]...
      if (position_ + 2 > dataSize_) break;
      uint16_t arrCount = readU16LE(data_ + position_);
      size_t scanPos = position_;
      scanPos += 2;
      for (uint16_t j = 0; j < arrCount; ++j) {
        if (scanPos >= dataSize_) break;
        ValueType vt = static_cast<ValueType>(data_[scanPos]);
        size_t fixed = valueTypeFixedSize(vt);
        scanPos += 1;
        if (fixed > 0) {
          scanPos += fixed;
        } else if (vt == ValueType::VNULL || vt == ValueType::UNDEFINED ||
                   vt == ValueType::BOOL_FALSE || vt == ValueType::BOOL_TRUE) {
          // no payload
        } else {
          break;
        }
      }
      prop.value.compoundSize = scanPos - position_;
      position_ = scanPos;
      break;
    }

    case ValueType::ERROR:
      // name + message + stack = 3 x u16
      if (position_ + 6 <= dataSize_) {
        prop.value.compoundData = data_ + position_;
        prop.value.compoundSize = 6;
        position_ += 6;
      }
      break;

    case ValueType::REGEXP:
      // source + flags = 2 x u16
      if (position_ + 4 <= dataSize_) {
        prop.value.compoundData = data_ + position_;
        prop.value.compoundSize = 4;
        position_ += 4;
      }
      break;

    default:
      break;
  }
  
  currentIndex_++;
  return prop;
}

// ============================================
// InstructionDecoder Implementation
// ============================================

std::optional<DecodedBatchHeader> InstructionDecoder::decodeHeader(
    const uint8_t* data, size_t size) {
  
  auto startTime = std::chrono::high_resolution_clock::now();
  
  stats_ = DecodingStats{};
  stats_.inputBytes = size;
  
  if (size < sizeof(BatchHeader)) {
    lastError_ = DecodeError::TRUNCATED_HEADER;
    return std::nullopt;
  }
  
  DecodedBatchHeader header;
  header.data = data;
  header.dataSize = size;
  
  // Parse header
  header.magic = readU32LE(data);
  header.version = readU16LE(data + 4);
  header.batchId = readU32LE(data + 6);
  header.opCount = readU16LE(data + 10);
  header.flags = data[12];
  
  // Validate
  if (header.magic != RILL_MAGIC) {
    lastError_ = DecodeError::INVALID_MAGIC;
    return std::nullopt;
  }
  
  if (header.version != PROTOCOL_VERSION) {
    lastError_ = DecodeError::VERSION_MISMATCH;
    return std::nullopt;
  }
  
  // Parse intern table
  header.internTableOffset = sizeof(BatchHeader);
  
  if (!persistentIntern_) {
    internTable_.clear();
  }
  
  size_t internBytes = internTable_.parse(data + header.internTableOffset, 
                                          size - header.internTableOffset);
  if (internBytes == 0 && header.opCount > 0) {
    lastError_ = DecodeError::TRUNCATED_DATA;
    return std::nullopt;
  }
  
  header.operationsOffset = header.internTableOffset + internBytes;
  
  auto endTime = std::chrono::high_resolution_clock::now();
  stats_.headerDecodingMs = std::chrono::duration<double, std::milli>(
      endTime - startTime).count();
  stats_.zeroCopy = true;
  
  lastError_ = DecodeError::OK;
  return header;
}

OperationIterator InstructionDecoder::createIterator(const DecodedBatchHeader& header) {
  return OperationIterator(
      header.data + header.operationsOffset,
      header.dataSize - header.operationsOffset,
      header.opCount,
      header.hasTimestamps(),
      &internTable_);
}

std::optional<DecodedValue> InstructionDecoder::decodeValue(
    const uint8_t* data, size_t size, size_t* bytesConsumed) {
  
  if (size < 1) return std::nullopt;
  
  DecodedValue value;
  value.type = static_cast<ValueType>(data[0]);
  size_t consumed = 1;
  
  switch (value.type) {
    case ValueType::VNULL:
    case ValueType::UNDEFINED:
      break;
      
    case ValueType::BOOL_FALSE:
      value.boolValue = false;
      break;
      
    case ValueType::BOOL_TRUE:
      value.boolValue = true;
      break;
      
    case ValueType::INT32:
      if (size < 5) return std::nullopt;
      value.int32Value = static_cast<int32_t>(readU32LE(data + 1));
      consumed = 5;
      break;
      
    case ValueType::FLOAT64:
      if (size < 9) return std::nullopt;
      value.float64Value = readF64LE(data + 1);
      consumed = 9;
      break;
      
    case ValueType::STRING:
    case ValueType::FUNCTION:
    case ValueType::PROMISE:
      if (size < 3) return std::nullopt;
      value.internIndex = readU16LE(data + 1);
      consumed = 3;
      break;
      
    case ValueType::DATE:
      if (size < 9) return std::nullopt;
      value.float64Value = readF64LE(data + 1);
      consumed = 9;
      break;
      
    default:
      // Compound types - store pointer
      value.compoundData = data + 1;
      value.compoundSize = size - 1;
      consumed = size; // Caller needs to handle
      break;
  }
  
  if (bytesConsumed) *bytesConsumed = consumed;
  return value;
}

void InstructionDecoder::reset() {
  internTable_.clear();
  lastError_ = DecodeError::OK;
  stats_ = DecodingStats{};
}

} // namespace rill::protocol
