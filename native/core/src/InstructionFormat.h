/**
 * InstructionFormat.h
 *
 * P3-X.1: Binary Instruction Protocol Format Definition
 *
 * Defines the binary wire format for Guest→Host operation batches.
 * Target KPIs:
 *   - Encoding: 5x faster than JSON (~2ms → <0.4ms for 100 CREATE)
 *   - Size: 60% smaller (~15KB → <6KB for 100 CREATE)
 *   - Decoding: Zero-copy with lazy props parsing
 *
 * Wire Format Overview:
 * ┌─────────────────────────────────────────────────────┐
 * │  Header (16 bytes)                                   │
 * ├─────────────────────────────────────────────────────┤
 * │  String Intern Table                                 │
 * ├─────────────────────────────────────────────────────┤
 * │  Operations [opCount]                                │
 * └─────────────────────────────────────────────────────┘
 */

#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include <unordered_map>

namespace rill::protocol {

// ============================================
// Magic Number & Version
// ============================================

/**
 * Magic number: "RILL" in ASCII (0x52 0x49 0x4C 0x4C)
 * Used to identify valid binary instruction batches
 */
constexpr uint32_t RILL_MAGIC = 0x4C4C4952; // Little-endian "RILL"

/**
 * Current protocol version
 * Increment when making breaking changes to the format
 */
constexpr uint16_t PROTOCOL_VERSION = 1;

// ============================================
// Header Layout (16 bytes, fixed size)
// ============================================

/**
 * Binary batch header
 *
 * Layout:
 *   Offset  Size  Field
 *   0       4     magic (0x4C4C4952 = "RILL")
 *   4       2     version
 *   6       4     batchId
 *   10      2     opCount
 *   12      1     flags
 *   13      3     reserved (padding to 16 bytes)
 */
#pragma pack(push, 1)
struct BatchHeader {
  uint32_t magic;      // Must be RILL_MAGIC
  uint16_t version;    // Protocol version
  uint32_t batchId;    // Batch sequence number
  uint16_t opCount;    // Number of operations in this batch
  uint8_t flags;       // Batch flags (see BatchFlags)
  uint8_t reserved[3]; // Reserved for future use, must be 0
};
#pragma pack(pop)

static_assert(sizeof(BatchHeader) == 16, "BatchHeader must be exactly 16 bytes");

/**
 * Batch flags
 */
namespace BatchFlags {
  constexpr uint8_t NONE = 0x00;
  
  // If set, string intern table uses delta encoding from previous batch
  constexpr uint8_t DELTA_INTERN = 0x01;
  
  // If set, batch contains only structural ops (no props)
  constexpr uint8_t STRUCTURAL_ONLY = 0x02;
  
  // If set, timestamps are included in operations
  constexpr uint8_t HAS_TIMESTAMPS = 0x04;
  
  // Reserved for future use
  constexpr uint8_t RESERVED_1 = 0x08;
  constexpr uint8_t RESERVED_2 = 0x10;
  constexpr uint8_t RESERVED_3 = 0x20;
  constexpr uint8_t RESERVED_4 = 0x40;
  constexpr uint8_t RESERVED_5 = 0x80;
}

// ============================================
// Operation Types
// ============================================

/**
 * Operation type encoding (u8)
 *
 * Matches TypeScript OperationType:
 *   'CREATE' | 'UPDATE' | 'DELETE' | 'APPEND' |
 *   'INSERT' | 'REMOVE' | 'REORDER' | 'TEXT' | 'REF_CALL'
 */
enum class OpType : uint8_t {
  CREATE   = 0x01,  // Create new node with type and props
  UPDATE   = 0x02,  // Update existing node's props
  DELETE   = 0x03,  // Delete node
  APPEND   = 0x04,  // Append child to parent
  INSERT   = 0x05,  // Insert child at index
  REMOVE   = 0x06,  // Remove child from parent
  REORDER  = 0x07,  // Reorder children
  TEXT     = 0x08,  // Update text content
  REF_CALL = 0x09,  // Remote ref method call
  
  // Reserved for future operations
  RESERVED_START = 0x10,
  
  // Invalid/unknown operation
  INVALID  = 0xFF,
};

/**
 * Convert OpType to string (for debugging)
 */
inline const char* opTypeToString(OpType type) {
  switch (type) {
    case OpType::CREATE:   return "CREATE";
    case OpType::UPDATE:   return "UPDATE";
    case OpType::DELETE:   return "DELETE";
    case OpType::APPEND:   return "APPEND";
    case OpType::INSERT:   return "INSERT";
    case OpType::REMOVE:   return "REMOVE";
    case OpType::REORDER:  return "REORDER";
    case OpType::TEXT:     return "TEXT";
    case OpType::REF_CALL: return "REF_CALL";
    default:               return "INVALID";
  }
}

/**
 * Check if operation type has props
 */
inline bool opTypeHasProps(OpType type) {
  return type == OpType::CREATE || type == OpType::UPDATE;
}

// ============================================
// Value Types
// ============================================

/**
 * Value type encoding (u8)
 *
 * Used in PropTable entries and ValueArray elements
 */
enum class ValueType : uint8_t {
  // Primitives
  VNULL      = 0x00,  // null
  UNDEFINED  = 0x01,  // undefined
  BOOL_FALSE = 0x02,  // false (no payload)
  BOOL_TRUE  = 0x03,  // true (no payload)
  INT32      = 0x04,  // 4 bytes, signed
  FLOAT64    = 0x05,  // 8 bytes, IEEE 754
  
  // String (intern table reference)
  STRING     = 0x06,  // u16 intern index
  
  // Function reference
  FUNCTION   = 0x07,  // u16 fnId intern index + optional metadata
  
  // Compound types
  OBJECT     = 0x08,  // Nested PropTable
  ARRAY      = 0x09,  // ValueArray
  
  // Special serialized types
  DATE       = 0x0A,  // float64 timestamp (ms since epoch)
  ERROR      = 0x0B,  // u16 name + u16 message + u16 stack (intern indexes)
  REGEXP     = 0x0C,  // u16 source + u16 flags (intern indexes)
  MAP        = 0x0D,  // u16 count + [key, value] pairs
  SET        = 0x0E,  // u16 count + values
  PROMISE    = 0x0F,  // u16 promiseId intern index
  
  // Optimized numeric types (future optimization)
  INT8       = 0x10,  // 1 byte, signed
  INT16      = 0x11,  // 2 bytes, signed
  UINT8      = 0x12,  // 1 byte, unsigned
  UINT16     = 0x13,  // 2 bytes, unsigned
  FLOAT32    = 0x14,  // 4 bytes, IEEE 754
  
  // Reserved
  RESERVED_START = 0x20,
  
  // Invalid
  INVALID    = 0xFF,
};

/**
 * Convert ValueType to string (for debugging)
 */
inline const char* valueTypeToString(ValueType type) {
  switch (type) {
    case ValueType::VNULL:      return "null";
    case ValueType::UNDEFINED:  return "undefined";
    case ValueType::BOOL_FALSE: return "false";
    case ValueType::BOOL_TRUE:  return "true";
    case ValueType::INT32:      return "int32";
    case ValueType::FLOAT64:    return "float64";
    case ValueType::STRING:     return "string";
    case ValueType::FUNCTION:   return "function";
    case ValueType::OBJECT:     return "object";
    case ValueType::ARRAY:      return "array";
    case ValueType::DATE:       return "date";
    case ValueType::ERROR:      return "error";
    case ValueType::REGEXP:     return "regexp";
    case ValueType::MAP:        return "map";
    case ValueType::SET:        return "set";
    case ValueType::PROMISE:    return "promise";
    case ValueType::INT8:       return "int8";
    case ValueType::INT16:      return "int16";
    case ValueType::UINT8:      return "uint8";
    case ValueType::UINT16:     return "uint16";
    case ValueType::FLOAT32:    return "float32";
    default:                    return "invalid";
  }
}

/**
 * Get the fixed payload size for a value type, or 0 if variable
 */
inline size_t valueTypeFixedSize(ValueType type) {
  switch (type) {
    case ValueType::VNULL:      return 0;
    case ValueType::UNDEFINED:  return 0;
    case ValueType::BOOL_FALSE: return 0;
    case ValueType::BOOL_TRUE:  return 0;
    case ValueType::INT8:       return 1;
    case ValueType::UINT8:      return 1;
    case ValueType::INT16:      return 2;
    case ValueType::UINT16:     return 2;
    case ValueType::INT32:      return 4;
    case ValueType::FLOAT32:    return 4;
    case ValueType::FLOAT64:    return 8;
    case ValueType::DATE:       return 8;
    case ValueType::STRING:     return 2; // intern index
    case ValueType::FUNCTION:   return 2; // fnId intern index (minimal)
    case ValueType::PROMISE:    return 2; // promiseId intern index
    default:                    return 0; // Variable size
  }
}

// ============================================
// String Intern Table
// ============================================

/**
 * String Intern Table Layout:
 *
 *   u16 count              - Number of strings
 *   [StringEntry] entries  - String entries
 *
 * StringEntry Layout:
 *   u16 length             - UTF-8 byte length
 *   u8[length] utf8        - UTF-8 bytes (NOT null-terminated)
 *
 * Total max strings: 65535 (u16 max)
 * Total max string length: 65535 bytes
 */

/**
 * Maximum number of strings in intern table
 */
constexpr uint16_t MAX_INTERN_STRINGS = 65535;

/**
 * Maximum single string length
 */
constexpr uint16_t MAX_STRING_LENGTH = 65535;

// ============================================
// Operation Layouts
// ============================================

/**
 * CREATE operation layout:
 *   u8  opType = 0x01
 *   u32 nodeId
 *   u16 typeRef      (intern table index for component type)
 *   PropTable props
 *   [u64 timestamp]  (optional, if HAS_TIMESTAMPS flag)
 */

/**
 * UPDATE operation layout:
 *   u8  opType = 0x02
 *   u32 nodeId
 *   PropTable props
 *   u16 removedCount
 *   u16[removedCount] removedProps  (intern table indexes)
 *   [u64 timestamp]
 */

/**
 * DELETE operation layout:
 *   u8  opType = 0x03
 *   u32 nodeId
 *   [u64 timestamp]
 */

/**
 * APPEND operation layout:
 *   u8  opType = 0x04
 *   u32 nodeId       (operation id, typically same as childId)
 *   u32 parentId
 *   u32 childId
 *   [u64 timestamp]
 */

/**
 * INSERT operation layout:
 *   u8  opType = 0x05
 *   u32 nodeId
 *   u32 parentId
 *   u32 childId
 *   u16 index
 *   [u64 timestamp]
 */

/**
 * REMOVE operation layout:
 *   u8  opType = 0x06
 *   u32 nodeId
 *   u32 parentId
 *   u32 childId
 *   [u64 timestamp]
 */

/**
 * REORDER operation layout:
 *   u8  opType = 0x07
 *   u32 nodeId
 *   u32 parentId
 *   u16 childCount
 *   u32[childCount] childIds
 *   [u64 timestamp]
 */

/**
 * TEXT operation layout:
 *   u8  opType = 0x08
 *   u32 nodeId
 *   u16 textRef      (intern table index)
 *   [u64 timestamp]
 */

/**
 * REF_CALL operation layout:
 *   u8  opType = 0x09
 *   u32 nodeId       (same as refId)
 *   u16 methodRef    (intern table index)
 *   u16 callIdRef    (intern table index)
 *   ValueArray args
 *   [u64 timestamp]
 */

// ============================================
// PropTable Layout
// ============================================

/**
 * PropTable Layout:
 *   u16 count              - Number of properties
 *   [PropEntry] entries    - Property entries
 *
 * PropEntry Layout:
 *   u16 keyRef             - Intern table index for property name
 *   u8  valueType          - ValueType enum
 *   [payload]              - Type-dependent payload
 */

// ============================================
// ValueArray Layout
// ============================================

/**
 * ValueArray Layout:
 *   u16 count              - Number of elements
 *   [ValueEntry] entries   - Value entries
 *
 * ValueEntry Layout:
 *   u8  valueType          - ValueType enum
 *   [payload]              - Type-dependent payload
 */

// ============================================
// Function Metadata (Extended)
// ============================================

/**
 * Function value can have extended metadata for DevTools
 *
 * Minimal layout (ValueType::FUNCTION):
 *   u16 fnIdRef           - Intern table index for fnId
 *
 * Extended layout (if batch has DevTools enabled):
 *   u16 fnIdRef
 *   u8  hasMetadata       - 0 or 1
 *   [if hasMetadata]:
 *     u16 nameRef         - Intern index for function name
 *     u16 sourceFileRef   - Intern index for source file
 *     u32 sourceLine      - Source line number
 */

// ============================================
// Error Handling
// ============================================

/**
 * Decoding error codes
 */
enum class DecodeError : uint8_t {
  OK = 0,
  INVALID_MAGIC,
  VERSION_MISMATCH,
  TRUNCATED_HEADER,
  TRUNCATED_DATA,
  INVALID_OP_TYPE,
  INVALID_VALUE_TYPE,
  INTERN_INDEX_OUT_OF_BOUNDS,
  MALFORMED_PROP_TABLE,
  MALFORMED_VALUE_ARRAY,
  BUFFER_OVERFLOW,
};

/**
 * Convert DecodeError to string
 */
inline const char* decodeErrorToString(DecodeError err) {
  switch (err) {
    case DecodeError::OK:                       return "OK";
    case DecodeError::INVALID_MAGIC:            return "Invalid magic number";
    case DecodeError::VERSION_MISMATCH:         return "Protocol version mismatch";
    case DecodeError::TRUNCATED_HEADER:         return "Truncated header";
    case DecodeError::TRUNCATED_DATA:           return "Truncated data";
    case DecodeError::INVALID_OP_TYPE:          return "Invalid operation type";
    case DecodeError::INVALID_VALUE_TYPE:       return "Invalid value type";
    case DecodeError::INTERN_INDEX_OUT_OF_BOUNDS: return "Intern index out of bounds";
    case DecodeError::MALFORMED_PROP_TABLE:     return "Malformed property table";
    case DecodeError::MALFORMED_VALUE_ARRAY:    return "Malformed value array";
    case DecodeError::BUFFER_OVERFLOW:          return "Buffer overflow";
    default:                                    return "Unknown error";
  }
}

// ============================================
// Encoding Statistics
// ============================================

/**
 * Statistics collected during encoding
 */
struct EncodingStats {
  size_t inputEstimatedBytes = 0;  // Estimated size of input JSI objects
  size_t outputBytes = 0;          // Actual binary output size
  double encodingMs = 0.0;         // Encoding time in milliseconds
  uint32_t internedStrings = 0;    // Number of strings in intern table
  uint32_t totalStringsEncoded = 0; // Total string references (including reuse)
  uint32_t operationCount = 0;     // Number of operations
  
  double compressionRatio() const {
    return inputEstimatedBytes > 0
      ? static_cast<double>(outputBytes) / inputEstimatedBytes
      : 1.0;
  }
  
  double internHitRate() const {
    return totalStringsEncoded > 0
      ? 1.0 - (static_cast<double>(internedStrings) / totalStringsEncoded)
      : 0.0;
  }
};

/**
 * Statistics collected during decoding
 */
struct DecodingStats {
  size_t inputBytes = 0;           // Binary input size
  double decodingMs = 0.0;         // Total decoding time
  double headerDecodingMs = 0.0;   // Header-only decoding time
  uint32_t operationsDecoded = 0;  // Operations fully decoded
  uint32_t propsLazySkipped = 0;   // Props skipped (lazy decoding)
  bool zeroCopy = true;            // True if no string allocations made
};

// ============================================
// Utility Functions
// ============================================

/**
 * Read little-endian u16 from buffer
 */
inline uint16_t readU16LE(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) |
         (static_cast<uint16_t>(data[1]) << 8);
}

/**
 * Read little-endian u32 from buffer
 */
inline uint32_t readU32LE(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) |
         (static_cast<uint32_t>(data[3]) << 24);
}

/**
 * Read little-endian u64 from buffer
 */
inline uint64_t readU64LE(const uint8_t* data) {
  return static_cast<uint64_t>(data[0]) |
         (static_cast<uint64_t>(data[1]) << 8) |
         (static_cast<uint64_t>(data[2]) << 16) |
         (static_cast<uint64_t>(data[3]) << 24) |
         (static_cast<uint64_t>(data[4]) << 32) |
         (static_cast<uint64_t>(data[5]) << 40) |
         (static_cast<uint64_t>(data[6]) << 48) |
         (static_cast<uint64_t>(data[7]) << 56);
}

/**
 * Read float64 from buffer (little-endian)
 */
inline double readF64LE(const uint8_t* data) {
  uint64_t bits = readU64LE(data);
  double result;
  std::memcpy(&result, &bits, sizeof(double));
  return result;
}

/**
 * Write little-endian u16 to buffer
 */
inline void writeU16LE(uint8_t* data, uint16_t value) {
  data[0] = static_cast<uint8_t>(value & 0xFF);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

/**
 * Write little-endian u32 to buffer
 */
inline void writeU32LE(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>(value & 0xFF);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

/**
 * Write little-endian u64 to buffer
 */
inline void writeU64LE(uint8_t* data, uint64_t value) {
  data[0] = static_cast<uint8_t>(value & 0xFF);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
  data[4] = static_cast<uint8_t>((value >> 32) & 0xFF);
  data[5] = static_cast<uint8_t>((value >> 40) & 0xFF);
  data[6] = static_cast<uint8_t>((value >> 48) & 0xFF);
  data[7] = static_cast<uint8_t>((value >> 56) & 0xFF);
}

/**
 * Write float64 to buffer (little-endian)
 */
inline void writeF64LE(uint8_t* data, double value) {
  uint64_t bits;
  std::memcpy(&bits, &value, sizeof(double));
  writeU64LE(data, bits);
}

} // namespace rill::protocol
