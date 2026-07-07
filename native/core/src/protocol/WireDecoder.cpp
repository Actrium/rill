// WIP — gated behind RILL_WIP_BINARY_PROTOCOL (off by default in production
// builds). Rationale, design, and status live in protocol/WireDecoder.h. In a
// normal build the #if makes this an empty translation unit.
#if RILL_WIP_BINARY_PROTOCOL

#include "WireDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <new>

namespace rill::protocol::wire {

const char* toString(WireError e) {
  switch (e) {
    case WireError::Ok: return "Ok";
    case WireError::TooLarge: return "TooLarge";
    case WireError::TruncatedHeader: return "TruncatedHeader";
    case WireError::BadMagic: return "BadMagic";
    case WireError::BadVersion: return "BadVersion";
    case WireError::BadFlags: return "BadFlags";
    case WireError::BadReserved: return "BadReserved";
    case WireError::TruncatedIntern: return "TruncatedIntern";
    case WireError::InternRefOutOfRange: return "InternRefOutOfRange";
    case WireError::TruncatedOps: return "TruncatedOps";
    case WireError::UnknownOpcode: return "UnknownOpcode";
    case WireError::UnknownValueTag: return "UnknownValueTag";
    case WireError::NonFiniteFloat: return "NonFiniteFloat";
    case WireError::InvalidDate: return "InvalidDate";
    case WireError::TrailingBytes: return "TrailingBytes";
    case WireError::NestingTooDeep: return "NestingTooDeep";
    case WireError::TotalElementsExceeded: return "TotalElementsExceeded";
    case WireError::OutOfMemory: return "OutOfMemory";
  }
  return "Unknown";
}

namespace {

// Internal fail-closed control-flow signal. Thrown by the reader on the first
// breach and caught at the decode() boundary; never escapes the decoder. This
// keeps the recursive value/op decoders free of per-read error plumbing while
// guaranteeing we abort the WHOLE batch (fail-closed) on any problem.
struct DecodeAbort {
  WireError error;
};

// Bounds-checked, little-endian cursor over the source buffer. Every read
// verifies remaining space BEFORE touching memory, so a malformed or truncated
// buffer can never cause an out-of-bounds read — it throws DecodeAbort instead.
class ByteReader {
public:
  ByteReader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

  size_t pos() const { return pos_; }
  size_t remaining() const { return size_ - pos_; }
  bool atEnd() const { return pos_ == size_; }

  uint8_t u8() {
    need(1);
    return data_[pos_++];
  }

  uint16_t u16() {
    need(2);
    uint16_t v = static_cast<uint16_t>(data_[pos_]) |
                 (static_cast<uint16_t>(data_[pos_ + 1]) << 8);
    pos_ += 2;
    return v;
  }

  uint32_t u32() {
    need(4);
    uint32_t v = static_cast<uint32_t>(data_[pos_]) |
                 (static_cast<uint32_t>(data_[pos_ + 1]) << 8) |
                 (static_cast<uint32_t>(data_[pos_ + 2]) << 16) |
                 (static_cast<uint32_t>(data_[pos_ + 3]) << 24);
    pos_ += 4;
    return v;
  }

  int32_t i32() { return static_cast<int32_t>(u32()); }

  // Schema: u64 emitted low-32 then high-32, each little-endian.
  uint64_t u64() {
    uint64_t lo = u32();
    uint64_t hi = u32();
    return lo | (hi << 32);
  }

  double f64() {
    need(8);
    uint64_t bits = 0;
    for (int i = 0; i < 8; ++i) {
      bits |= static_cast<uint64_t>(data_[pos_ + i]) << (8 * i);
    }
    pos_ += 8;
    double d;
    std::memcpy(&d, &bits, sizeof(d));
    return d;
  }

  // Returns a zero-copy view of `len` raw bytes and advances past them.
  std::string_view bytes(size_t len) {
    need(len);
    std::string_view sv(reinterpret_cast<const char*>(data_ + pos_), len);
    pos_ += len;
    return sv;
  }

  // Throw a specific error at a semantic checkpoint.
  [[noreturn]] static void fail(WireError e) { throw DecodeAbort{e}; }

private:
  // Guards every read: if fewer than `n` bytes remain, abort fail-closed.
  void need(size_t n) {
    if (n > size_ - pos_) {
      throw DecodeAbort{WireError::TruncatedOps};
    }
  }

  const uint8_t* data_;
  size_t size_;
  size_t pos_ = 0;
};

// Bundles the reader with the already-parsed intern table so nested decoders
// can resolve internRefs fail-closed.
struct DecodeCtx {
  ByteReader& r;
  const std::vector<std::string_view>& intern;

  // ONE per-batch running count over ALL element kinds, matching the schema's
  // limits.maxTotalElements definition: every VALUE NODE (every scalar AND every
  // container, at every nesting level, is 1) PLUS every REORDER childId PLUS
  // every UPDATE removedProp reference PLUS every intern-table entry. Each is
  // exactly 1. Charged BEFORE the offending element is constructed/reserved; a
  // breach of kMaxTotalElements is rejected fail-closed before any allocation.
  // Bounds ALL decoder allocation to this single cap — without it the three
  // non-value collections (childIds u32 each, removed internRef each, intern
  // entries) were bounded solely by maxBatchBytes, so a legal <=16 MiB batch
  // packed with them decoded to hundreds of MB of native structures.
  uint64_t totalElements = 0;

  // Charge `n` more elements against the shared budget; reject the moment the
  // batch would exceed limits.maxTotalElements (BEFORE allocating/reserving the
  // offending elements). For a collection, pass its wire-declared count BEFORE
  // reserveClamped so the reserve itself is bounded by the remaining budget.
  void countElements(uint64_t n) {
    totalElements += n;
    if (totalElements > kMaxTotalElements) {
      ByteReader::fail(WireError::TotalElementsExceeded);
    }
  }

  // Account for one more value node (each scalar / container in decodeValue).
  void countValue() { countElements(1); }

  // Resolve a u16 internRef; reject (fail-closed) if >= intern count.
  std::string_view resolve(uint16_t ref) const {
    if (ref >= intern.size()) {
      ByteReader::fail(WireError::InternRefOutOfRange);
    }
    return intern[ref];
  }

  std::string_view internRef() const { return resolve(r.u16()); }
};

// A container-value's element count is a u16 read from the wire, but every
// element consumes at least one more byte, so the true upper bound on how many
// elements can actually follow is remaining(). Reserving min(count, remaining())
// keeps the common case (accurate reserve) fast while making a bogus u16 count
// on a short buffer unable to trigger an enormous eager allocation (bad_alloc)
// before the per-element reads fail-close on truncation.
template <typename Vec>
void reserveClamped(Vec& v, uint16_t count, const ByteReader& r) {
  v.reserve(std::min<size_t>(count, r.remaining()));
}

// `depth` is the container-nesting depth this value occupies IF it is a
// container (top-level values are depth 1; a container's children are depth+1).
// Only container values are depth-checked, matching the schema's rule that
// depth counts nesting of container values only.
WireValue decodeValue(DecodeCtx& ctx, uint32_t depth); // fwd

// OBJECT / props share the same (key internRef, value) entry shape. `depth` is
// the depth of the entry VALUES (already advanced by the caller).
std::vector<std::pair<std::string_view, WireValue>> decodeKeyedEntries(DecodeCtx& ctx,
                                                                        uint32_t depth) {
  uint16_t count = ctx.r.u16();
  std::vector<std::pair<std::string_view, WireValue>> out;
  reserveClamped(out, count, ctx.r);
  for (uint16_t i = 0; i < count; ++i) {
    std::string_view key = ctx.internRef();
    out.emplace_back(key, decodeValue(ctx, depth));
  }
  return out;
}

WireValue decodeValue(DecodeCtx& ctx, uint32_t depth) {
  // Count this value node against the batch-wide budget BEFORE constructing or
  // reserving anything for it, so a breach fails closed with NOTHING allocated.
  ctx.countValue();
  WireValue v;
  uint8_t tagByte = ctx.r.u8();
  v.tag = static_cast<ValueTag>(tagByte);
  switch (v.tag) {
    case ValueTag::Null:
    case ValueTag::Undefined:
      break;
    case ValueTag::BoolFalse:
      v.boolValue = false;
      break;
    case ValueTag::BoolTrue:
      v.boolValue = true;
      break;
    case ValueTag::Int32:
      v.int32Value = ctx.r.i32();
      break;
    case ValueTag::Float64: {
      double d = ctx.r.f64();
      // Schema: NaN/Infinity are not legal in a FLOAT64 value.
      if (!std::isfinite(d)) {
        ByteReader::fail(WireError::NonFiniteFloat);
      }
      v.doubleValue = d;
      break;
    }
    case ValueTag::String:
    case ValueTag::Function:
    case ValueTag::Promise:
      v.str = ctx.internRef();
      break;
    case ValueTag::Object:
      // Reject BEFORE recursing so a maliciously deep tree cannot overflow the
      // native stack (a stack-overflow crash is uncatchable by DecodeAbort).
      if (depth > kMaxValueDepth) {
        ByteReader::fail(WireError::NestingTooDeep);
      }
      v.objectEntries = decodeKeyedEntries(ctx, depth + 1);
      break;
    case ValueTag::Array: {
      if (depth > kMaxValueDepth) {
        ByteReader::fail(WireError::NestingTooDeep);
      }
      uint16_t length = ctx.r.u16();
      reserveClamped(v.arrayItems, length, ctx.r);
      for (uint16_t i = 0; i < length; ++i) {
        v.arrayItems.push_back(decodeValue(ctx, depth + 1));
      }
      break;
    }
    case ValueTag::Date: {
      double d = ctx.r.f64();
      // Schema (limits.maxDateMs): epochMs must be finite and within the
      // ECMAScript Date range; beyond it a JS Date is Invalid. Match the TS
      // decoder and Rust encoder so the same bytes are valid on every codec.
      if (!std::isfinite(d) || d < -kMaxDateMs || d > kMaxDateMs) {
        ByteReader::fail(WireError::InvalidDate);
      }
      v.doubleValue = d;
      break;
    }
    case ValueTag::Error:
      v.errorName = ctx.internRef();
      v.errorMessage = ctx.internRef();
      v.errorStack = ctx.internRef();
      break;
    case ValueTag::Regexp:
      v.regexpSource = ctx.internRef();
      v.regexpFlags = ctx.internRef();
      break;
    case ValueTag::Map: {
      if (depth > kMaxValueDepth) {
        ByteReader::fail(WireError::NestingTooDeep);
      }
      uint16_t entryCount = ctx.r.u16();
      reserveClamped(v.mapEntries, entryCount, ctx.r);
      for (uint16_t i = 0; i < entryCount; ++i) {
        WireValue key = decodeValue(ctx, depth + 1);
        WireValue val = decodeValue(ctx, depth + 1);
        v.mapEntries.emplace_back(std::move(key), std::move(val));
      }
      break;
    }
    case ValueTag::Set: {
      if (depth > kMaxValueDepth) {
        ByteReader::fail(WireError::NestingTooDeep);
      }
      uint16_t count = ctx.r.u16();
      reserveClamped(v.arrayItems, count, ctx.r);
      for (uint16_t i = 0; i < count; ++i) {
        v.arrayItems.push_back(decodeValue(ctx, depth + 1));
      }
      break;
    }
    default:
      ByteReader::fail(WireError::UnknownValueTag);
  }
  return v;
}

// Top-level prop values live at depth 1 (their container nesting starts here).
std::vector<WireProp> decodePropsTable(DecodeCtx& ctx) {
  uint16_t entryCount = ctx.r.u16();
  std::vector<WireProp> props;
  reserveClamped(props, entryCount, ctx.r);
  for (uint16_t i = 0; i < entryCount; ++i) {
    WireProp p;
    p.key = ctx.internRef();
    p.value = decodeValue(ctx, 1);
    props.push_back(std::move(p));
  }
  return props;
}

WireOp decodeOp(DecodeCtx& ctx, bool hasTimestamps) {
  WireOp op;
  uint8_t opcode = ctx.r.u8();
  op.kind = static_cast<OpKind>(opcode);
  op.id = ctx.r.u32(); // every op carries a u32 id

  switch (op.kind) {
    case OpKind::Create:
      op.type = ctx.internRef();
      op.props = decodePropsTable(ctx);
      break;
    case OpKind::Update: {
      op.props = decodePropsTable(ctx);
      uint16_t removedCount = ctx.r.u16();
      // Each removed reference is one element on the shared budget; check the
      // whole count against the remaining cap BEFORE reserving so the reserve is
      // bounded (a bogus u16 count cannot pre-allocate past the cap).
      ctx.countElements(removedCount);
      reserveClamped(op.removed, removedCount, ctx.r);
      for (uint16_t i = 0; i < removedCount; ++i) {
        op.removed.push_back(ctx.internRef());
      }
      break;
    }
    case OpKind::Delete:
      break;
    case OpKind::Append:
    case OpKind::Remove:
      op.parentId = ctx.r.u32();
      op.childId = ctx.r.u32();
      break;
    case OpKind::Insert:
      op.parentId = ctx.r.u32();
      op.childId = ctx.r.u32();
      op.index = ctx.r.u16();
      break;
    case OpKind::Reorder: {
      op.parentId = ctx.r.u32();
      uint16_t childCount = ctx.r.u16();
      // Each childId is one element on the shared budget; check the whole count
      // against the remaining cap BEFORE reserving so the reserve is bounded (a
      // bogus u16 count cannot pre-allocate past the cap).
      ctx.countElements(childCount);
      reserveClamped(op.childIds, childCount, ctx.r);
      for (uint16_t i = 0; i < childCount; ++i) {
        op.childIds.push_back(ctx.r.u32());
      }
      break;
    }
    case OpKind::Text:
      op.text = ctx.internRef();
      break;
    case OpKind::RefCall: {
      op.refId = op.id; // schema: refId is NOT on the wire; mirror id
      op.method = ctx.internRef();
      op.callId = ctx.internRef();
      uint16_t argCount = ctx.r.u16();
      reserveClamped(op.args, argCount, ctx.r);
      for (uint16_t i = 0; i < argCount; ++i) {
        op.args.push_back(decodeValue(ctx, 1));
      }
      break;
    }
    default:
      ByteReader::fail(WireError::UnknownOpcode);
  }

  if (hasTimestamps) {
    op.timestamp = ctx.r.u64();
  }
  return op;
}

} // namespace

std::optional<WireBatch> WireDecoder::decode(const uint8_t* data, size_t size) {
  lastError_ = WireError::Ok;

  // maxBatchBytes: reject an oversized buffer before doing anything else.
  if (size > kMaxBatchBytes) {
    lastError_ = WireError::TooLarge;
    return std::nullopt;
  }
  if (data == nullptr && size != 0) {
    lastError_ = WireError::TruncatedHeader;
    return std::nullopt;
  }
  if (size < kHeaderBytes) {
    lastError_ = WireError::TruncatedHeader;
    return std::nullopt;
  }

  try {
    ByteReader r(data, size);

    // --- Header (16 bytes) ---
    uint32_t magic = r.u32();
    if (magic != kMagic) {
      ByteReader::fail(WireError::BadMagic);
    }
    uint16_t version = r.u16();
    if (version != kProtocolVersion) {
      ByteReader::fail(WireError::BadVersion);
    }
    uint32_t batchId = r.u32();
    uint16_t opCount = r.u16();
    uint8_t flagsByte = r.u8();
    // Only HAS_TIMESTAMPS is acceptable in v1. DELTA_INTERN / STRUCTURAL_ONLY
    // are recognised-but-rejected; any higher bit is unknown -> reject.
    if ((flagsByte & static_cast<uint8_t>(~flags::kHasTimestamps)) != 0) {
      ByteReader::fail(WireError::BadFlags);
    }
    uint8_t reserved0 = r.u8();
    uint8_t reserved1 = r.u8();
    uint8_t reserved2 = r.u8();
    if (reserved0 != 0 || reserved1 != 0 || reserved2 != 0) {
      ByteReader::fail(WireError::BadReserved);
    }
    const bool hasTimestamps = (flagsByte & flags::kHasTimestamps) != 0;

    WireBatch batch;
    batch.version = version;
    batch.batchId = batchId;
    batch.flags = flagsByte;

    // One shared per-batch element budget (value nodes + REORDER childIds +
    // UPDATE removed refs + intern entries), created before the intern table so
    // the intern entries are charged to the same counter as the ops.
    DecodeCtx ctx{r, batch.intern};

    // --- Intern table ---
    // A truncated intern table (byteLen running past the buffer) is reported as
    // TruncatedIntern rather than the generic op-truncation error.
    uint16_t internCount = r.u16();
    // Each intern entry is one element on the shared budget; check the whole
    // count against the cap BEFORE reserving so the reserve is bounded.
    ctx.countElements(internCount);
    batch.intern.reserve(std::min<size_t>(internCount, r.remaining()));
    for (uint16_t i = 0; i < internCount; ++i) {
      uint16_t byteLen = r.u16();
      if (byteLen > r.remaining()) {
        ByteReader::fail(WireError::TruncatedIntern);
      }
      batch.intern.push_back(r.bytes(byteLen));
    }

    // --- Operations ---
    batch.ops.reserve(std::min<size_t>(opCount, r.remaining()));
    for (uint16_t i = 0; i < opCount; ++i) {
      batch.ops.push_back(decodeOp(ctx, hasTimestamps));
    }

    // Fail-closed on trailing garbage: a well-formed batch is fully consumed.
    if (!r.atEnd()) {
      ByteReader::fail(WireError::TrailingBytes);
    }

    return batch;
  } catch (const DecodeAbort& abort) {
    lastError_ = abort.error;
    return std::nullopt;
  } catch (const std::bad_alloc&) {
    // Backstop: any allocation that still slips past the clamped reserves (e.g.
    // an accumulation of many small allocations) is converted to a fail-closed
    // decode error rather than being allowed to escape and crash the host.
    lastError_ = WireError::OutOfMemory;
    return std::nullopt;
  }
}

} // namespace rill::protocol::wire

#endif // RILL_WIP_BINARY_PROTOCOL
