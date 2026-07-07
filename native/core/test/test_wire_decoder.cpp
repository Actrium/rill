// Golden-vector conformance test for the op-batch binary wire DECODER.
//
// The vectors below are copied verbatim from contracts/op-batch-wire.golden.json
// (the fixed cross-language oracle). Each decodes a batch and asserts the
// reconstructed structure equals the documented `batch`. Fail-closed behaviour
// (malformed / truncated / out-of-range input -> nullopt, no OOB read) is
// covered by the negative cases at the bottom.
//
// The WIP decoder is gated behind RILL_WIP_BINARY_PROTOCOL (always defined for
// the test build via native/core/Makefile WIP_DEFS). When the flag is off this
// file still provides an empty registration so test/main.cpp links.
#include "test_framework.h"

#if RILL_WIP_BINARY_PROTOCOL

#include "../src/protocol/WireDecoder.h"

#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

using namespace rill::protocol::wire;
using namespace rill::test;

namespace {

// Parse a lowercase hex string into raw bytes.
std::vector<uint8_t> hexToBytes(const std::string& hex) {
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2);
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<uint8_t>((nibble(hex[i]) << 4) | nibble(hex[i + 1])));
  }
  return out;
}

// The returned WireBatch holds string_views INTO the decoded buffer, so that
// buffer must outlive every assertion made against the batch. Park each buffer
// in a run-lifetime store: moving a std::vector preserves its heap data pointer,
// so growing `keepAlive` never invalidates views already handed out.
WireBatch decodeOk(const std::string& hex) {
  static std::vector<std::vector<uint8_t>> keepAlive;
  keepAlive.push_back(hexToBytes(hex));
  const std::vector<uint8_t>& bytes = keepAlive.back();
  WireDecoder dec;
  auto batch = dec.decode(bytes.data(), bytes.size());
  assertTrue(batch.has_value(),
             std::string("expected decode success, got ") + toString(dec.lastError()));
  return std::move(*batch);
}

void assertStringValue(const WireValue& v, std::string_view expected) {
  assertTrue(v.tag == ValueTag::String, "value tag should be STRING");
  assertEqual<std::string_view>(v.str, expected, "string value");
}

// Golden hex strings (contracts/op-batch-wire.golden.json).
const std::string kEmptyBatch = "52494c4c0100000000000000000000000000";
const std::string kOneCreate =
    "52494c4c0100010000000100000000000100040056696577010100000000000000";
const std::string kSetPropRepeatedKey =
    "52494c4c01000200000002000000000003000900636c6173734e616d6501006101"
    "006202010000000100000006010000000202000000010000000602000000";
const std::string kMixedFiveOps =
    "52494c4c0100030000000500000000000600040056696577020069640400726f6f"
    "740400546578740200486904006d61696e0101000000000001000100060200010200"
    "0000030000000400000000010000000200000008020000000400020100000001000100"
    "0605000000";

TestSuite createWireDecoderTests() {
  TestSuite suite{"WireDecoder", {}};

  // --- Golden vector: empty-batch ---
  suite.cases.push_back({"golden: empty-batch", []() {
    WireBatch b = decodeOk(kEmptyBatch);
    assertEqual<uint16_t>(b.version, 1, "version");
    assertEqual<uint32_t>(b.batchId, 0, "batchId");
    assertEqual<uint8_t>(b.flags, 0, "flags");
    assertFalse(b.hasTimestamps(), "no timestamps");
    assertEqual(b.intern.size(), size_t{0}, "intern count");
    assertEqual(b.ops.size(), size_t{0}, "op count");
  }});

  // --- Golden vector: one-create ---
  suite.cases.push_back({"golden: one-create", []() {
    WireBatch b = decodeOk(kOneCreate);
    assertEqual<uint32_t>(b.batchId, 1, "batchId");
    assertEqual(b.intern.size(), size_t{1}, "intern count");
    assertEqual<std::string_view>(b.intern[0], "View", "intern[0]");
    assertEqual(b.ops.size(), size_t{1}, "op count");

    const WireOp& op = b.ops[0];
    assertTrue(op.kind == OpKind::Create, "op0 is CREATE");
    assertEqual<uint32_t>(op.id, 1, "op0 id");
    assertEqual<std::string_view>(op.type, "View", "op0 type");
    assertEqual(op.props.size(), size_t{0}, "op0 props empty");
  }});

  // --- Golden vector: setprop-repeated-key (interning reuse) ---
  suite.cases.push_back({"golden: setprop-repeated-key", []() {
    WireBatch b = decodeOk(kSetPropRepeatedKey);
    assertEqual<uint32_t>(b.batchId, 2, "batchId");
    assertEqual(b.intern.size(), size_t{3}, "intern count");
    assertEqual<std::string_view>(b.intern[0], "className", "intern[0]");
    assertEqual<std::string_view>(b.intern[1], "a", "intern[1]");
    assertEqual<std::string_view>(b.intern[2], "b", "intern[2]");
    assertEqual(b.ops.size(), size_t{2}, "op count");

    const WireOp& op0 = b.ops[0];
    assertTrue(op0.kind == OpKind::Update, "op0 UPDATE");
    assertEqual<uint32_t>(op0.id, 1, "op0 id");
    assertEqual(op0.props.size(), size_t{1}, "op0 props");
    assertEqual<std::string_view>(op0.props[0].key, "className", "op0 key");
    assertStringValue(op0.props[0].value, "a");
    assertEqual(op0.removed.size(), size_t{0}, "op0 removed");

    const WireOp& op1 = b.ops[1];
    assertTrue(op1.kind == OpKind::Update, "op1 UPDATE");
    assertEqual<uint32_t>(op1.id, 2, "op1 id");
    assertEqual(op1.props.size(), size_t{1}, "op1 props");
    // Same key intern index reused across both ops.
    assertEqual<std::string_view>(op1.props[0].key, "className", "op1 key reused");
    assertStringValue(op1.props[0].value, "b");
    assertEqual(op1.removed.size(), size_t{0}, "op1 removed");
  }});

  // --- Golden vector: mixed-five-ops ---
  suite.cases.push_back({"golden: mixed-five-ops", []() {
    WireBatch b = decodeOk(kMixedFiveOps);
    assertEqual<uint32_t>(b.batchId, 3, "batchId");
    assertEqual(b.intern.size(), size_t{6}, "intern count");
    assertEqual<std::string_view>(b.intern[0], "View", "intern[0]");
    assertEqual<std::string_view>(b.intern[1], "id", "intern[1]");
    assertEqual<std::string_view>(b.intern[2], "root", "intern[2]");
    assertEqual<std::string_view>(b.intern[3], "Text", "intern[3]");
    assertEqual<std::string_view>(b.intern[4], "Hi", "intern[4]");
    assertEqual<std::string_view>(b.intern[5], "main", "intern[5]");
    assertEqual(b.ops.size(), size_t{5}, "op count");

    const WireOp& op0 = b.ops[0];
    assertTrue(op0.kind == OpKind::Create, "op0 CREATE");
    assertEqual<uint32_t>(op0.id, 1, "op0 id");
    assertEqual<std::string_view>(op0.type, "View", "op0 type");
    assertEqual(op0.props.size(), size_t{1}, "op0 props");
    assertEqual<std::string_view>(op0.props[0].key, "id", "op0 key");
    assertStringValue(op0.props[0].value, "root");

    const WireOp& op1 = b.ops[1];
    assertTrue(op1.kind == OpKind::Create, "op1 CREATE");
    assertEqual<uint32_t>(op1.id, 2, "op1 id");
    assertEqual<std::string_view>(op1.type, "Text", "op1 type");
    assertEqual(op1.props.size(), size_t{0}, "op1 props empty");

    const WireOp& op2 = b.ops[2];
    assertTrue(op2.kind == OpKind::Append, "op2 APPEND");
    assertEqual<uint32_t>(op2.id, 0, "op2 id");
    assertEqual<uint32_t>(op2.parentId, 1, "op2 parentId");
    assertEqual<uint32_t>(op2.childId, 2, "op2 childId");

    const WireOp& op3 = b.ops[3];
    assertTrue(op3.kind == OpKind::Text, "op3 TEXT");
    assertEqual<uint32_t>(op3.id, 2, "op3 id");
    assertEqual<std::string_view>(op3.text, "Hi", "op3 text");

    const WireOp& op4 = b.ops[4];
    assertTrue(op4.kind == OpKind::Update, "op4 UPDATE");
    assertEqual<uint32_t>(op4.id, 1, "op4 id");
    assertEqual(op4.props.size(), size_t{1}, "op4 props");
    assertEqual<std::string_view>(op4.props[0].key, "id", "op4 key reused");
    assertStringValue(op4.props[0].value, "main");
    assertEqual(op4.removed.size(), size_t{0}, "op4 removed");
  }});

  // --- Fail-closed: buffer shorter than the 16-byte header ---
  suite.cases.push_back({"fail-closed: truncated header", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes.resize(10);
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::TruncatedHeader, "TruncatedHeader");
  }});

  // --- Fail-closed: wrong magic ---
  suite.cases.push_back({"fail-closed: bad magic", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes[0] = 0x00; // corrupt first magic byte
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::BadMagic, "BadMagic");
  }});

  // --- Fail-closed: unsupported version ---
  suite.cases.push_back({"fail-closed: bad version", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes[4] = 0x02; // version low byte -> 2
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::BadVersion, "BadVersion");
  }});

  // --- Fail-closed: reserved flag bit set (DELTA_INTERN) ---
  suite.cases.push_back({"fail-closed: reserved flag", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes[12] = flags::kDeltaIntern; // flags byte at header offset 12
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::BadFlags, "BadFlags");
  }});

  // --- Fail-closed: nonzero reserved header bytes ---
  suite.cases.push_back({"fail-closed: nonzero reserved", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes[13] = 0x01; // first reserved byte
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::BadReserved, "BadReserved");
  }});

  // --- Fail-closed: trailing bytes after the last op ---
  suite.cases.push_back({"fail-closed: trailing bytes", []() {
    auto bytes = hexToBytes(kEmptyBatch);
    bytes.push_back(0xFF); // one extra byte
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::TrailingBytes, "TrailingBytes");
  }});

  // --- Fail-closed: internRef out of range ---
  // Header opCount=1, intern count=0, then CREATE id=1 type=internRef(0).
  suite.cases.push_back({"fail-closed: internRef out of range", []() {
    std::vector<uint8_t> bytes = {
        0x52, 0x49, 0x4c, 0x4c,             // magic 'RILL'
        0x01, 0x00,                         // version 1
        0x00, 0x00, 0x00, 0x00,             // batchId
        0x01, 0x00,                         // opCount = 1
        0x00,                               // flags
        0x00, 0x00, 0x00,                   // reserved
        0x00, 0x00,                         // intern count = 0
        0x01,                               // opcode CREATE
        0x01, 0x00, 0x00, 0x00,             // id = 1
        0x00, 0x00,                         // type internRef 0 (out of range)
    };
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::InternRefOutOfRange, "InternRefOutOfRange");
  }});

  // --- Fail-closed: unknown opcode ---
  suite.cases.push_back({"fail-closed: unknown opcode", []() {
    std::vector<uint8_t> bytes = {
        0x52, 0x49, 0x4c, 0x4c,
        0x01, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x01, 0x00,                         // opCount = 1
        0x00,
        0x00, 0x00, 0x00,
        0x00, 0x00,                         // intern count = 0
        0x7f,                               // opcode 0x7f (unknown)
        0x01, 0x00, 0x00, 0x00,             // id = 1
    };
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::UnknownOpcode, "UnknownOpcode");
  }});

  // --- Fail-closed: truncated op record (declares 1 op, buffer ends early) ---
  suite.cases.push_back({"fail-closed: truncated op", []() {
    auto bytes = hexToBytes(kOneCreate);
    bytes.resize(bytes.size() - 3); // drop part of the CREATE record
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "should reject");
    assertTrue(dec.lastError() == WireError::TruncatedOps, "TruncatedOps");
  }});

  // --- Fail-closed: deep value nesting (NestingTooDeep, no SIGSEGV) ---
  // Build a CREATE whose single prop value is `containerDepth` nested ARRAYs
  // (each a 1-element array) bottoming out in a NULL. The k-th array is decoded
  // at container-nesting depth k, so `containerDepth` is the deepest container.
  auto buildNestedArrayBatch = [](uint32_t containerDepth) -> std::vector<uint8_t> {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    // Header.
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(1);                                    // opCount = 1
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    // Intern table: [0]="View" (CREATE type), [1]="k" (prop key).
    u16le(2);
    u16le(4);
    b.insert(b.end(), {'V', 'i', 'e', 'w'});
    u16le(1);
    b.push_back('k');
    // Op: CREATE id=1 type=intern[0] props={ k: <nested arrays> }.
    b.push_back(0x01); // opcode CREATE
    u32le(1);          // id
    u16le(0);          // type internRef 0 ("View")
    u16le(1);          // propsTable entryCount = 1
    u16le(1);          // key internRef 1 ("k")
    for (uint32_t i = 0; i < containerDepth; ++i) {
      b.push_back(static_cast<uint8_t>(ValueTag::Array));
      u16le(1); // length = 1
    }
    b.push_back(static_cast<uint8_t>(ValueTag::Null)); // innermost scalar leaf
    return b;
  };

  suite.cases.push_back({"fail-closed: value nested past maxValueDepth", [buildNestedArrayBatch]() {
    // One level past the cap: the (cap+1)-th container is rejected.
    auto bytes = buildNestedArrayBatch(kMaxValueDepth + 1);
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "over-deep value should reject (not crash)");
    assertTrue(dec.lastError() == WireError::NestingTooDeep, "NestingTooDeep");
  }});

  suite.cases.push_back({"depth-cap: value exactly at maxValueDepth decodes", [buildNestedArrayBatch]() {
    // A value whose deepest container sits exactly at the cap still decodes.
    auto bytes = buildNestedArrayBatch(kMaxValueDepth);
    WireDecoder dec;
    auto decoded = dec.decode(bytes.data(), bytes.size());
    assertTrue(decoded.has_value(),
               std::string("expected decode success, got ") + toString(dec.lastError()));
    WireBatch b = std::move(*decoded);
    assertEqual(b.ops.size(), size_t{1}, "one op");
    const WireOp& op = b.ops[0];
    assertTrue(op.kind == OpKind::Create, "CREATE");
    assertEqual(op.props.size(), size_t{1}, "one prop");
    // Walk down the nesting to confirm it reconstructed to full depth.
    const WireValue* v = &op.props[0].value;
    for (uint32_t d = 1; d < kMaxValueDepth; ++d) {
      assertTrue(v->tag == ValueTag::Array, "array level");
      assertEqual(v->arrayItems.size(), size_t{1}, "single child");
      v = &v->arrayItems[0];
    }
    assertTrue(v->tag == ValueTag::Array, "innermost array");
    assertEqual(v->arrayItems.size(), size_t{1}, "innermost single child");
    assertTrue(v->arrayItems[0].tag == ValueTag::Null, "leaf is NULL");
  }});

  // --- Fail-closed: DATE domain (limits.maxDateMs) ---------------------------
  // A CREATE whose single prop `k` is a DATE with the given epochMs (f64 LE).
  auto buildDateBatch = [](double ms) -> std::vector<uint8_t> {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(1);                                    // opCount = 1
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    u16le(2);
    u16le(4);
    b.insert(b.end(), {'V', 'i', 'e', 'w'});
    u16le(1);
    b.push_back('k');
    b.push_back(0x01); // CREATE
    u32le(1);          // id
    u16le(0);          // type internRef 0
    u16le(1);          // propsTable entryCount = 1
    u16le(1);          // key internRef 1
    b.push_back(static_cast<uint8_t>(ValueTag::Date));
    uint8_t raw[8];
    std::memcpy(raw, &ms, 8); // native little-endian (x86_64 / arm64)
    b.insert(b.end(), raw, raw + 8);
    return b;
  };

  suite.cases.push_back({"fail-closed: DATE NaN/Inf/out-of-range rejected (InvalidDate)", [buildDateBatch]() {
    const double bad[] = {std::numeric_limits<double>::quiet_NaN(),
                          std::numeric_limits<double>::infinity(),
                          -std::numeric_limits<double>::infinity(), 1e300, -1e300};
    for (double ms : bad) {
      auto bytes = buildDateBatch(ms);
      WireDecoder dec;
      auto r = dec.decode(bytes.data(), bytes.size());
      assertFalse(r.has_value(), "invalid Date should reject (not accept as-is)");
      assertTrue(dec.lastError() == WireError::InvalidDate, "InvalidDate");
    }
  }});

  suite.cases.push_back({"DATE at the range cap decodes", [buildDateBatch]() {
    auto bytes = buildDateBatch(8.64e15); // exactly limits.maxDateMs
    WireDecoder dec;
    auto decoded = dec.decode(bytes.data(), bytes.size());
    assertTrue(decoded.has_value(), "valid Date should decode");
    assertTrue(decoded->ops[0].props[0].value.tag == ValueTag::Date, "Date value");
  }});

  // --- Total-elements cap (limits.maxTotalElements) --------------------------
  // Build a CREATE whose single prop value is an OUTER array of `outerLen` INNER
  // arrays (each holding `innerLen` 1-byte NULL leaves) followed by `extraNulls`
  // 1-byte NULL leaves (a tail used only to land the count on an exact target
  // that the uniform nested shape alone cannot reach). The batch's total
  // ELEMENT count is exactly: 2 intern entries ("View","k") + 1 (outer array) +
  // outerLen * (1 + innerLen) + extraNulls. This is the amplification shape: a
  // small (<16 MiB) buffer of mostly 1-byte NULLs that, unbounded, would inflate
  // into GBs of WireValue structs.
  auto buildManyNullsBatch = [](uint32_t outerLen, uint32_t innerLen,
                                uint32_t extraNulls) -> std::vector<uint8_t> {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    // Header.
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(1);                                    // opCount = 1
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    // Intern table: [0]="View" (CREATE type), [1]="k" (prop key).
    u16le(2);
    u16le(4);
    b.insert(b.end(), {'V', 'i', 'e', 'w'});
    u16le(1);
    b.push_back('k');
    // Op: CREATE id=1 type=intern[0] props={ k: <outer array> }.
    b.push_back(0x01); // opcode CREATE
    u32le(1);          // id
    u16le(0);          // type internRef 0 ("View")
    u16le(1);          // propsTable entryCount = 1
    u16le(1);          // key internRef 1 ("k")
    // Outer array of `outerLen` inner arrays then `extraNulls` trailing NULLs.
    b.push_back(static_cast<uint8_t>(ValueTag::Array));
    u16le(static_cast<uint16_t>(outerLen + extraNulls));
    for (uint32_t i = 0; i < outerLen; ++i) {
      b.push_back(static_cast<uint8_t>(ValueTag::Array));
      u16le(static_cast<uint16_t>(innerLen));
      for (uint32_t j = 0; j < innerLen; ++j) {
        b.push_back(static_cast<uint8_t>(ValueTag::Null)); // 1-byte leaf
      }
    }
    for (uint32_t j = 0; j < extraNulls; ++j) {
      b.push_back(static_cast<uint8_t>(ValueTag::Null)); // trailing 1-byte leaf
    }
    return b;
  };

  // Sanity: the at-cap shape's TOTAL element count (2 intern entries + value
  // nodes) lands exactly on the cap. Value nodes = 1 (outer) + 25*(1+41941) +
  // 23 (trailing NULLs) = 1048574; + 2 intern entries = 1048576 == the cap.
  static_assert(2u + 1u + 25u * (1u + 41941u) + 23u == 1048576u, "at-cap total count");
  static_assert(kMaxTotalElements == 1048576u, "cap wired from schema");

  // --- Fail-closed: amplification batch just over the total-elements cap ---
  // 2 intern + 1 + 25*(1+41943) = 1048603 elements (> cap), in ~1.05 MB
  // (< 16 MiB). Rejected the moment the count would exceed the cap; the decoded
  // footprint is bounded to ~cap WireValues instead of ballooning to multi-GB.
  suite.cases.push_back({"fail-closed: total elements over cap", [buildManyNullsBatch]() {
    auto bytes = buildManyNullsBatch(25, 41943, 0);
    assertTrue(bytes.size() < kMaxBatchBytes, "PoC buffer stays under maxBatchBytes");
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "over-cap amplification should reject (not balloon RSS)");
    assertTrue(dec.lastError() == WireError::TotalElementsExceeded, "TotalElementsExceeded");
  }});

  // --- Total-elements cap: a batch EXACTLY at the cap still decodes ---
  // 2 intern + 1 + 25*(1+41941) + 23 = 1048576 == cap: the last element is
  // accepted. The outer array holds 25 inner arrays followed by 23 NULL leaves.
  suite.cases.push_back({"total-elements: batch exactly at cap decodes", [buildManyNullsBatch]() {
    auto bytes = buildManyNullsBatch(25, 41941, 23);
    WireDecoder dec;
    auto decoded = dec.decode(bytes.data(), bytes.size());
    assertTrue(decoded.has_value(),
               std::string("at-cap batch should decode, got ") + toString(dec.lastError()));
    WireBatch b = std::move(*decoded);
    assertEqual(b.ops.size(), size_t{1}, "one op");
    const WireOp& op = b.ops[0];
    assertEqual(op.props.size(), size_t{1}, "one prop");
    const WireValue& outer = op.props[0].value;
    assertTrue(outer.tag == ValueTag::Array, "outer array");
    assertEqual(outer.arrayItems.size(), size_t{48}, "25 inner arrays + 23 NULLs");
    assertEqual(outer.arrayItems[0].arrayItems.size(), size_t{41941}, "inner length");
    assertTrue(outer.arrayItems[0].arrayItems[0].tag == ValueTag::Null, "leaf NULL");
    assertTrue(outer.arrayItems[25].tag == ValueTag::Null, "trailing leaf NULL");
  }});

  // --- Total-elements cap over the NON-VALUE collections ---------------------
  // limits.maxTotalElements folds REORDER childIds, UPDATE removedProp refs and
  // intern entries into the SAME per-batch running count that caps value nodes.
  // Each op's declared count is u16-bounded (<= 65535), so a single op cannot
  // breach the cap; the DoS is the AGGREGATE across ops. These builders pack
  // many full ops so the running count crosses the cap at a final op whose own
  // elements are charged BEFORE its reserve/read — so the breach is rejected
  // fail-closed without reserving or materialising them (bounded RSS).

  // A batch of `fullOps` REORDER ops each carrying a FULL u16 childId list
  // (65535 real u32 childIds), then one final REORDER op that DECLARES
  // `finalChildCount` childIds but (optionally) writes none of their bytes.
  // REORDER carries no internRef, so the intern table is empty.
  auto buildReorderBatch = [](uint32_t fullOps, uint16_t finalChildCount,
                              bool writeFinalChildIds) -> std::vector<uint8_t> {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(static_cast<uint16_t>(fullOps + 1));   // opCount (full ops + final)
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    u16le(0);                                    // intern count = 0
    const uint16_t kFull = 65535;
    for (uint32_t op = 0; op < fullOps; ++op) {
      b.push_back(static_cast<uint8_t>(OpKind::Reorder));
      u32le(op + 1); // id
      u32le(1);      // parentId
      u16le(kFull);  // childCount
      for (uint32_t i = 0; i < kFull; ++i) u32le(i); // real childIds
    }
    // Final REORDER: declares finalChildCount; withholding its childId bytes
    // proves a decoder charging the declared count BEFORE the reserve/read
    // rejects without ever touching them.
    b.push_back(static_cast<uint8_t>(OpKind::Reorder));
    u32le(fullOps + 1);
    u32le(1);
    u16le(finalChildCount);
    if (writeFinalChildIds) {
      for (uint32_t i = 0; i < finalChildCount; ++i) u32le(i);
    }
    return b;
  };

  // A batch of `fullOps` UPDATE ops each with an empty propsTable and a FULL u16
  // removed list (65535 internRef(0) references), then one final UPDATE that
  // DECLARES `finalRemovedCount` removed refs but (optionally) writes none. The
  // intern table holds ONE empty-string entry so internRef(0) always resolves.
  auto buildUpdateRemovedBatch = [](uint32_t fullOps, uint16_t finalRemovedCount,
                                    bool writeFinalRemoved) -> std::vector<uint8_t> {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(static_cast<uint16_t>(fullOps + 1));   // opCount
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    u16le(1);                                    // intern count = 1
    u16le(0);                                    // entry[0] byteLen = 0 (empty)
    const uint16_t kFull = 65535;
    for (uint32_t op = 0; op < fullOps; ++op) {
      b.push_back(static_cast<uint8_t>(OpKind::Update));
      u32le(op + 1); // id
      u16le(0);      // propsTable entryCount = 0
      u16le(kFull);  // removedCount
      for (uint32_t i = 0; i < kFull; ++i) u16le(0); // removed internRef 0
    }
    b.push_back(static_cast<uint8_t>(OpKind::Update));
    u32le(fullOps + 1);
    u16le(0);                 // props entryCount = 0
    u16le(finalRemovedCount); // declared removed count
    if (writeFinalRemoved) {
      for (uint32_t i = 0; i < finalRemovedCount; ++i) u16le(0);
    }
    return b;
  };

  // 16*65535 == 1048560 (< cap) leaves headroom for the final op to tip over.
  static_assert(16u * 65535u == 1048560u, "reorder full-op accumulation");

  // --- Fail-closed: REORDER childIds push the batch over the cap ---
  suite.cases.push_back({"fail-closed: REORDER childIds over total-elements cap",
                         [buildReorderBatch]() {
    // 16 full ops charge 1048560 childIds; the final op declares 65535 more,
    // crossing the cap. Rejected BEFORE the final op's childIds are reserved or
    // read (none are present), so RSS stays bounded to ~cap elements.
    auto bytes = buildReorderBatch(16, 65535, /*writeFinalChildIds=*/false);
    assertTrue(bytes.size() < kMaxBatchBytes, "PoC buffer stays under maxBatchBytes");
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "over-cap childIds should reject (not balloon RSS)");
    assertTrue(dec.lastError() == WireError::TotalElementsExceeded, "TotalElementsExceeded");
  }});

  // --- Total-elements cap: REORDER childIds exactly at the cap still decode ---
  suite.cases.push_back({"total-elements: REORDER childIds exactly at cap decodes",
                         [buildReorderBatch]() {
    // 16*65535 + 16 == 1048576 == cap: the last childId is accepted.
    auto bytes = buildReorderBatch(16, 16, /*writeFinalChildIds=*/true);
    WireDecoder dec;
    auto decoded = dec.decode(bytes.data(), bytes.size());
    assertTrue(decoded.has_value(),
               std::string("at-cap REORDER batch should decode, got ") + toString(dec.lastError()));
    WireBatch b = std::move(*decoded);
    assertEqual(b.ops.size(), size_t{17}, "17 ops");
    assertTrue(b.ops[0].kind == OpKind::Reorder, "op0 REORDER");
    assertEqual(b.ops[0].childIds.size(), size_t{65535}, "full childId list");
    assertEqual(b.ops[16].childIds.size(), size_t{16}, "final childId list");
    assertEqual<uint32_t>(b.ops[16].childIds[15], 15, "last childId value");
  }});

  // --- Fail-closed: UPDATE removed refs push the batch over the cap ---
  suite.cases.push_back({"fail-closed: UPDATE removed refs over total-elements cap",
                         [buildUpdateRemovedBatch]() {
    // intern(1) + 16*65535 removed refs = 1048561; the final UPDATE declares
    // 65535 more, crossing the cap. Rejected BEFORE those refs are reserved or
    // resolved (none are present).
    auto bytes = buildUpdateRemovedBatch(16, 65535, /*writeFinalRemoved=*/false);
    assertTrue(bytes.size() < kMaxBatchBytes, "PoC buffer stays under maxBatchBytes");
    WireDecoder dec;
    auto r = dec.decode(bytes.data(), bytes.size());
    assertFalse(r.has_value(), "over-cap removed refs should reject (not balloon RSS)");
    assertTrue(dec.lastError() == WireError::TotalElementsExceeded, "TotalElementsExceeded");
  }});

  // --- Total-elements: a small REORDER + UPDATE batch decodes (real data) ---
  suite.cases.push_back({"total-elements: small REORDER+UPDATE batch decodes", []() {
    std::vector<uint8_t> b;
    auto u16le = [&](uint16_t v) {
      b.push_back(static_cast<uint8_t>(v & 0xff));
      b.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
    };
    auto u32le = [&](uint32_t v) {
      for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
    };
    b.insert(b.end(), {0x52, 0x49, 0x4c, 0x4c}); // magic 'RILL'
    u16le(1);                                    // version
    u32le(0);                                    // batchId
    u16le(2);                                    // opCount = 2
    b.push_back(0x00);                           // flags
    b.insert(b.end(), {0x00, 0x00, 0x00});       // reserved
    u16le(1);                                    // intern count = 1
    u16le(3);                                    // entry[0] byteLen = 3
    b.insert(b.end(), {'c', 'l', 's'});          // intern[0] = "cls"
    // op0: REORDER id=7 parentId=1 childIds=[10,20,30].
    b.push_back(static_cast<uint8_t>(OpKind::Reorder));
    u32le(7);
    u32le(1);
    u16le(3);
    u32le(10);
    u32le(20);
    u32le(30);
    // op1: UPDATE id=8 props={} removed=[internRef0].
    b.push_back(static_cast<uint8_t>(OpKind::Update));
    u32le(8);
    u16le(0); // props entryCount
    u16le(1); // removedCount
    u16le(0); // removed internRef 0 ("cls")
    WireDecoder dec;
    // The decoded batch borrows `b`, which stays in scope for every assertion.
    auto decoded = dec.decode(b.data(), b.size());
    assertTrue(decoded.has_value(),
               std::string("small batch should decode, got ") + toString(dec.lastError()));
    assertEqual(decoded->ops.size(), size_t{2}, "2 ops");
    const WireOp& r0 = decoded->ops[0];
    assertTrue(r0.kind == OpKind::Reorder, "op0 REORDER");
    assertEqual<uint32_t>(r0.parentId, 1, "parentId");
    assertEqual(r0.childIds.size(), size_t{3}, "3 childIds");
    assertEqual<uint32_t>(r0.childIds[0], 10, "childId0");
    assertEqual<uint32_t>(r0.childIds[2], 30, "childId2");
    const WireOp& u1 = decoded->ops[1];
    assertTrue(u1.kind == OpKind::Update, "op1 UPDATE");
    assertEqual(u1.removed.size(), size_t{1}, "1 removed");
    assertEqual<std::string_view>(u1.removed[0], "cls", "removed[0]");
  }});

  return suite;
}

} // namespace

void registerWireDecoderTests() {
  TestRunner::instance().addSuite(createWireDecoderTests());
}

#else // !RILL_WIP_BINARY_PROTOCOL

void registerWireDecoderTests() {}

#endif // RILL_WIP_BINARY_PROTOCOL
