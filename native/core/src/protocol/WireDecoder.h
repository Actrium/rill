// ============================================================================
// WIP — gated behind RILL_WIP_BINARY_PROTOCOL (off by default in production
// builds). The ENTIRE body of this header is inside the #if, mirroring the
// gating style of devtools/CDPServer.* and security/SecurityManager.* — in a
// normal build this compiles to an empty translation unit (no binary weight,
// no accidental use). Enable for evaluation with RILL_WIP_BINARY_PROTOCOL=1.
//
// WHAT THIS IS
//   A fail-closed, zero-copy DECODER for the guest->host op-batch BINARY wire
//   protocol. The single source of truth for the format is
//   contracts/op-batch-wire.json; the fixed oracle is
//   contracts/op-batch-wire.golden.json. This decoder is locked to that schema
//   by the golden-vector conformance test (test/test_wire_decoder.cpp). It is
//   the native mirror of the TS decoder src/shared/bridge/binary-protocol.ts.
//
// DESIGN
//   - Zero-copy: every string is a std::string_view INTO the caller's buffer,
//     resolved through the batch's intern table. The decoded WireBatch and every
//     WireValue string_view it holds are only valid while that buffer is alive.
//   - Fail-closed: any malformed / oversized / out-of-range / truncated input
//     makes decode() return std::nullopt and set lastError(); the decoder never
//     performs an out-of-bounds read and never yields a partial op list. On any
//     error NOTHING crosses the seam.
//
// STATUS
//   Not wired into any live path. Decoder only (no encoder here). Header/flags,
//   intern table, all 9 opcodes and all 16 value tags from the v1 schema are
//   implemented. HAS_TIMESTAMPS is decoded; DELTA_INTERN / STRUCTURAL_ONLY are
//   recognised and rejected (v1 never emits them).
// ============================================================================
#pragma once

#if RILL_WIP_BINARY_PROTOCOL

#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

namespace rill::protocol::wire {

// --- Constants generated from contracts/op-batch-wire.json (v1) -------------

// magic.u32le: 0x4c4c4952 = 'RILL' read little-endian.
constexpr uint32_t kMagic = 0x4c4c4952u;
constexpr uint16_t kProtocolVersion = 1;
constexpr size_t kHeaderBytes = 16;

// limits.* — hard structural bounds (mostly u16 field widths).
constexpr size_t kMaxBatchBytes = 16u * 1024u * 1024u; // 16 MiB
constexpr uint32_t kMaxInternStrings = 65535u;
constexpr uint32_t kMaxStringBytes = 65535u;
constexpr uint32_t kMaxCollectionElements = 65535u;
// Container-value nesting cap (limits.maxValueDepth). Depth counts nesting of
// container values only (OBJECT/ARRAY/MAP/SET), starting at 1 for a top-level
// value. Bounds native-stack recursion so a maliciously deep value tree cannot
// overflow the C++ stack — a breach is rejected fail-closed (NestingTooDeep).
constexpr uint32_t kMaxValueDepth = 64u;
// Total ELEMENT budget for a single batch (limits.maxTotalElements). ONE
// per-batch running count spanning ALL element kinds: every VALUE NODE (each
// scalar AND each container OBJECT/ARRAY/MAP/SET is 1, at every nesting level,
// a container's children counting in addition to the container itself), PLUS
// every REORDER childId, PLUS every UPDATE removedProp reference, PLUS every
// intern-table entry — each exactly 1. Bounds the decoded footprint: without it
// a <=16 MiB buffer packed with any of these inflates into hundreds of MB of
// native structures (a resource-exhaustion DoS on the untrusted guest->host
// seam). Charging only value nodes left the three non-value collections
// (childIds, removedProps, intern entries) bounded solely by maxBatchBytes, so
// a legal <=16 MiB batch decoded to ~322 MB (measured). maxBatchBytes is the
// outer byte bound; this is the inner element-count bound. A breach is rejected
// fail-closed (TotalElementsExceeded) BEFORE the offending element is allocated.
constexpr uint32_t kMaxTotalElements = 1048576u;

// limits.maxDateMs: a DATE value's epochMs must be finite and within the
// ECMAScript Date range (+/-8.64e15 ms); beyond it a JS Date is Invalid. Matched
// by the TS decoder and Rust encoder so the same bytes are valid on every codec.
// A breach is rejected fail-closed (InvalidDate).
constexpr double kMaxDateMs = 8.64e15;

// batchFlags bitmask.
namespace flags {
constexpr uint8_t kNone = 0x00;
constexpr uint8_t kDeltaIntern = 0x01;     // reserved in v1; reject if set
constexpr uint8_t kStructuralOnly = 0x02;  // reserved in v1; reject if set
constexpr uint8_t kHasTimestamps = 0x04;   // appends a u64 after every op record
} // namespace flags

// opcodes (u8 leading each op record).
enum class OpKind : uint8_t {
  Create = 1,
  Update = 2,
  Delete = 3,
  Append = 4,
  Insert = 5,
  Remove = 6,
  Reorder = 7,
  Text = 8,
  RefCall = 9,
};

// valueTags (u8 leading each encoded SerializedValue).
enum class ValueTag : uint8_t {
  Null = 0,
  Undefined = 1,
  BoolFalse = 2,
  BoolTrue = 3,
  Int32 = 4,
  Float64 = 5,
  String = 6,
  Function = 7,
  Object = 8,
  Array = 9,
  Date = 10,
  Error = 11,
  Regexp = 12,
  Map = 13,
  Set = 14,
  Promise = 15,
};

// --- Decoded structures -----------------------------------------------------
//
// Owning tree of the batch. Scalars are stored by value; strings are
// string_views into the source buffer (resolved via the intern table).

struct WireValue; // fwd

struct WireObjectEntry {
  std::string_view key; // intern-resolved
  // value stored out-of-line so WireValue can be an incomplete-friendly member
  // via vector; see below.
};

struct WireValue {
  ValueTag tag = ValueTag::Null;

  // Scalar payloads (only the one matching `tag` is meaningful).
  bool boolValue = false;         // BoolFalse / BoolTrue
  int32_t int32Value = 0;         // Int32
  double doubleValue = 0.0;       // Float64, and Date (epochMs)

  // Interned-string payloads.
  std::string_view str;           // String; Function fnId; Promise promiseId
  std::string_view errorName;     // Error
  std::string_view errorMessage;  // Error
  std::string_view errorStack;    // Error
  std::string_view regexpSource;  // Regexp
  std::string_view regexpFlags;   // Regexp

  // Compound payloads.
  std::vector<std::pair<std::string_view, WireValue>> objectEntries; // Object
  std::vector<WireValue> arrayItems;                                 // Array; Set
  std::vector<std::pair<WireValue, WireValue>> mapEntries;           // Map
};

struct WireProp {
  std::string_view key;
  WireValue value;
};

struct WireOp {
  OpKind kind = OpKind::Create;
  uint32_t id = 0;

  // CREATE
  std::string_view type;
  // CREATE + UPDATE
  std::vector<WireProp> props;
  // UPDATE
  std::vector<std::string_view> removed;
  // APPEND / INSERT / REMOVE / REORDER
  uint32_t parentId = 0;
  uint32_t childId = 0;
  uint16_t index = 0;          // INSERT
  std::vector<uint32_t> childIds; // REORDER
  // TEXT
  std::string_view text;
  // REF_CALL (refId mirrors id per schema note)
  std::string_view method;
  std::string_view callId;
  uint32_t refId = 0;
  std::vector<WireValue> args;

  // Present only when HAS_TIMESTAMPS is set.
  std::optional<uint64_t> timestamp;
};

struct WireBatch {
  uint16_t version = 0;
  uint32_t batchId = 0;
  uint8_t flags = 0;
  std::vector<std::string_view> intern; // index -> UTF-8 bytes in source buffer
  std::vector<WireOp> ops;

  bool hasTimestamps() const { return (flags & flags::kHasTimestamps) != 0; }
};

// --- Errors -----------------------------------------------------------------

enum class WireError {
  Ok = 0,
  TooLarge,            // buffer exceeds maxBatchBytes
  TruncatedHeader,     // fewer than 16 header bytes
  BadMagic,
  BadVersion,
  BadFlags,            // reserved/unknown flag bit set
  BadReserved,         // reserved header bytes not zero
  TruncatedIntern,     // intern table runs past end of buffer
  InternRefOutOfRange, // an internRef >= intern count
  TruncatedOps,        // an op record runs past end of buffer
  UnknownOpcode,
  UnknownValueTag,
  NonFiniteFloat,      // Float64 payload was NaN/Infinity (illegal per schema)
  InvalidDate,         // Date epochMs was NaN/Infinity or outside limits.maxDateMs
  TrailingBytes,       // bytes left over after opCount records (malformed)
  NestingTooDeep,      // container value nested past limits.maxValueDepth
  TotalElementsExceeded, // batch element count (values + childIds + removed + intern) would exceed limits.maxTotalElements
  OutOfMemory,         // an allocation failed while decoding (fail-closed backstop)
};

const char* toString(WireError e);

// --- Decoder ----------------------------------------------------------------
//
// Stateless across calls apart from lastError_. decode() rebuilds the intern
// table fresh from each batch (v1 always ships the FULL table).

class WireDecoder {
public:
  // Decode a complete batch. Returns std::nullopt on ANY error (fail-closed);
  // inspect lastError() for the reason. The returned WireBatch (and every
  // string_view inside it) borrows `data`, so it must not outlive that buffer.
  std::optional<WireBatch> decode(const uint8_t* data, size_t size);

  WireError lastError() const { return lastError_; }

private:
  WireError lastError_ = WireError::Ok;
};

} // namespace rill::protocol::wire

#endif // RILL_WIP_BINARY_PROTOCOL
