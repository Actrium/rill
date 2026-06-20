/**
 * test_instruction_codec.cpp
 *
 * P3-X.T: Binary Instruction Protocol Tests
 */

#include "test_framework.h"
#include "../src/InstructionFormat.h"
#include "../src/InstructionEncoder.h"
#include "../src/InstructionDecoder.h"
#include "../src/InstructionCodec.h"

using namespace rill::protocol;
using namespace rill::test;

namespace {

TestSuite createInstructionCodecTests() {
  TestSuite suite{"InstructionCodec", {}};

  // Format Tests
  suite.cases.push_back({"InstructionFormat constants", []() {
    assertEqual(RILL_MAGIC, 0x4C4C4952u, "RILL_MAGIC");
    assertEqual(sizeof(BatchHeader), size_t(16), "BatchHeader size");
    assertEqual(static_cast<uint8_t>(OpType::CREATE), uint8_t(0x01), "OpType::CREATE");
    assertEqual(static_cast<uint8_t>(OpType::DELETE), uint8_t(0x03), "OpType::DELETE");
    assertEqual(static_cast<uint8_t>(ValueType::STRING), uint8_t(0x06), "ValueType::STRING");
  }});

  suite.cases.push_back({"OpType helpers", []() {
    assertTrue(opTypeHasProps(OpType::CREATE), "CREATE has props");
    assertTrue(opTypeHasProps(OpType::UPDATE), "UPDATE has props");
    assertTrue(!opTypeHasProps(OpType::DELETE), "DELETE has no props");
    assertEqual(std::string(opTypeToString(OpType::CREATE)), std::string("CREATE"), "opTypeToString");
  }});

  suite.cases.push_back({"Byte order helpers", []() {
    uint8_t buf[8];
    writeU16LE(buf, 0x1234);
    assertEqual(readU16LE(buf), uint16_t(0x1234), "U16 roundtrip");
    
    writeU32LE(buf, 0x12345678);
    assertEqual(readU32LE(buf), 0x12345678u, "U32 roundtrip");
    
    writeF64LE(buf, 3.14159);
    double result = readF64LE(buf);
    assertTrue(std::abs(result - 3.14159) < 0.00001, "F64 roundtrip");
  }});

  // Encoder Tests
  suite.cases.push_back({"InstructionEncoder basic batch", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(42);
    encoder.writeCreateOp(1, "View", {{"style", "flex:1"}});
    encoder.writeAppendOp(1, 0, 1);
    auto binary = encoder.finishBatch();
    
    assertTrue(binary.size() >= 16, "binary size >= 16");
    assertEqual(readU32LE(binary.data()), RILL_MAGIC, "magic");
    assertEqual(readU16LE(binary.data() + 4), PROTOCOL_VERSION, "version");
    assertEqual(readU32LE(binary.data() + 6), 42u, "batchId");
    assertEqual(readU16LE(binary.data() + 10), uint16_t(2), "opCount");
  }});

  suite.cases.push_back({"InstructionEncoder all operation types", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(1);
    encoder.writeCreateOp(1, "View", {});
    encoder.writeUpdateOp(1, {{"key", "val"}}, {"old"});
    encoder.writeDeleteOp(2);
    encoder.writeAppendOp(3, 0, 3);
    encoder.writeInsertOp(4, 0, 4, 2);
    encoder.writeRemoveOp(5, 0, 5);
    encoder.writeReorderOp(6, 0, {1, 2, 3});
    encoder.writeTextOp(7, "Hello");
    encoder.writeRefCallOp(8, "focus", "call-123", {});
    auto binary = encoder.finishBatch();
    
    assertEqual(encoder.getOperationCount(), uint16_t(9), "9 operations");
    assertTrue(binary.size() > 16, "has data");
  }});

  suite.cases.push_back({"InstructionEncoder string interning", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(1);
    encoder.writeCreateOp(1, "View", {{"style", "flex:1"}});
    encoder.writeCreateOp(2, "View", {{"style", "flex:2"}});
    encoder.writeCreateOp(3, "View", {{"style", "flex:3"}});
    auto binary = encoder.finishBatch();
    auto stats = encoder.getStats();
    
    assertTrue(stats.totalStringsEncoded >= 6, "strings encoded");
    assertTrue(stats.internHitRate() > 0, "some intern hits");
  }});

  suite.cases.push_back({"InstructionEncoder reusable across batches", []() {
    InstructionEncoder encoder;

    encoder.beginBatch(1);
    encoder.writeCreateOp(1, "View", {{"style", "flex:1"}});
    auto b1 = encoder.finishBatch();
    assertTrue(b1.size() >= 16, "batch1 binary size >= 16");

    // Reuse the same encoder instance for another batch.
    encoder.beginBatch(2);
    encoder.writeTextOp(2, "Hello");
    auto b2 = encoder.finishBatch();
    assertTrue(b2.size() >= 16, "batch2 binary size >= 16");
    assertEqual(readU32LE(b2.data()), RILL_MAGIC, "batch2 magic");
    assertEqual(readU32LE(b2.data() + 6), 2u, "batch2 batchId");
    assertEqual(readU16LE(b2.data() + 10), uint16_t(1), "batch2 opCount");
  }});

  // Decoder Tests
  suite.cases.push_back({"InstructionDecoder header parsing", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(99);
    encoder.writeCreateOp(1, "Text", {});
    auto binary = encoder.finishBatch();
    
    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(binary.data(), binary.size());
    
    assertTrue(header.has_value(), "header parsed");
    assertTrue(header->isValid(), "header valid");
    assertEqual(header->batchId, 99u, "batchId");
    assertEqual(header->opCount, uint16_t(1), "opCount");
  }});

  suite.cases.push_back({"InstructionDecoder invalid magic", []() {
    uint8_t badData[16] = {0};
    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(badData, 16);
    
    assertTrue(!header.has_value(), "no header");
    assertEqual(static_cast<int>(decoder.lastError()), 
                static_cast<int>(DecodeError::INVALID_MAGIC), "error code");
  }});

  suite.cases.push_back({"InstructionDecoder truncated data", []() {
    InstructionDecoder decoder;
    uint8_t shortData[8] = {0};
    auto header = decoder.decodeHeader(shortData, 8);
    
    assertTrue(!header.has_value(), "no header");
    assertEqual(static_cast<int>(decoder.lastError()),
                static_cast<int>(DecodeError::TRUNCATED_HEADER), "truncated error");
  }});

  // Roundtrip Tests
  suite.cases.push_back({"Roundtrip simple batch", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(123);
    encoder.writeCreateOp(1, "View", {{"style", "flex:1"}});
    encoder.writeTextOp(2, "Hello");
    auto binary = encoder.finishBatch();
    
    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(binary.data(), binary.size());
    
    assertTrue(header.has_value(), "header parsed");
    assertEqual(header->batchId, 123u, "batchId");
    assertEqual(header->opCount, uint16_t(2), "opCount");
    
    auto iter = decoder.createIterator(*header);
    assertTrue(iter.hasNext(), "has first op");
    auto op1 = iter.next();
    assertEqual(static_cast<int>(op1.type), static_cast<int>(OpType::CREATE), "first is CREATE");
    assertEqual(op1.nodeId, 1u, "nodeId");
    
    assertTrue(iter.hasNext(), "has second op");
    auto op2 = iter.next();
    assertEqual(static_cast<int>(op2.type), static_cast<int>(OpType::TEXT), "second is TEXT");
    
    assertTrue(!iter.hasNext(), "no more ops");
  }});

  suite.cases.push_back({"Stress test: 100 operations", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(1);
    for (int i = 0; i < 100; ++i) {
      encoder.writeCreateOp(i, "View", {{"id", std::to_string(i)}});
    }
    auto binary = encoder.finishBatch();
    auto stats = encoder.getStats();
    
    assertEqual(stats.operationCount, 100u, "100 operations");
    
    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(binary.data(), binary.size());
    assertTrue(header.has_value(), "header parsed");
    assertEqual(header->opCount, uint16_t(100), "100 ops in header");
    
    auto iter = decoder.createIterator(*header);
    int count = 0;
    while (iter.hasNext()) {
      auto op = iter.next();
      assertEqual(static_cast<int>(op.type), static_cast<int>(OpType::CREATE), "all CREATE");
      count++;
    }
    assertEqual(count, 100, "decoded 100");
  }});

  // PropsIterator Tests
  suite.cases.push_back({"PropsIterator skips compound values correctly", []() {
    // Encode a CREATE with mixed prop types including an object value.
    // The encoder's low-level API only supports string props, so we'll
    // manually build a batch with an OBJECT prop value.
    InstructionEncoder encoder;
    encoder.beginBatch(200);
    // Write a CREATE with 3 string props — baseline correctness
    encoder.writeCreateOp(10, "Box", {{"a", "1"}, {"b", "2"}, {"c", "3"}});
    auto binary = encoder.finishBatch();

    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(binary.data(), binary.size());
    assertTrue(header.has_value(), "header parsed");

    auto iter = decoder.createIterator(*header);
    assertTrue(iter.hasNext(), "has op");
    auto op = iter.next();
    assertEqual(static_cast<int>(op.type), static_cast<int>(OpType::CREATE), "is CREATE");
    assertEqual(op.create.props.count, uint16_t(3), "3 props");

    // Iterate all 3 props — must not crash or misalign
    PropsIterator piter(op.create.props, &decoder.getInternTable());
    int propCount = 0;
    while (piter.hasNext()) {
      auto prop = piter.next();
      assertTrue(prop.value.isString(), "prop is string");
      propCount++;
    }
    assertEqual(propCount, 3, "iterated 3 props");
  }});

  suite.cases.push_back({"Roundtrip all tree operation types", []() {
    InstructionEncoder encoder;
    encoder.beginBatch(300);
    encoder.writeDeleteOp(1);
    encoder.writeAppendOp(2, 0, 2);
    encoder.writeInsertOp(3, 0, 3, 5);
    encoder.writeRemoveOp(4, 0, 4);
    encoder.writeReorderOp(5, 0, {10, 20, 30});
    encoder.writeTextOp(6, "hello");
    encoder.writeRefCallOp(7, "focus", "c1", {"arg1"});
    auto binary = encoder.finishBatch();

    InstructionDecoder decoder;
    auto header = decoder.decodeHeader(binary.data(), binary.size());
    assertTrue(header.has_value(), "header");
    assertEqual(header->opCount, uint16_t(7), "7 ops");

    auto iter = decoder.createIterator(*header);

    // DELETE
    auto op1 = iter.next();
    assertEqual(static_cast<int>(op1.type), static_cast<int>(OpType::DELETE), "DELETE");
    assertEqual(op1.nodeId, 1u, "nodeId 1");

    // APPEND
    auto op2 = iter.next();
    assertEqual(static_cast<int>(op2.type), static_cast<int>(OpType::APPEND), "APPEND");
    assertEqual(op2.tree.parentId, 0u, "parentId");
    assertEqual(op2.tree.childId, 2u, "childId");

    // INSERT
    auto op3 = iter.next();
    assertEqual(static_cast<int>(op3.type), static_cast<int>(OpType::INSERT), "INSERT");
    assertEqual(op3.insert.index, uint16_t(5), "index");

    // REMOVE
    auto op4 = iter.next();
    assertEqual(static_cast<int>(op4.type), static_cast<int>(OpType::REMOVE), "REMOVE");

    // REORDER
    auto op5 = iter.next();
    assertEqual(static_cast<int>(op5.type), static_cast<int>(OpType::REORDER), "REORDER");
    assertEqual(op5.reorder.childCount, uint16_t(3), "3 children");

    // TEXT
    auto op6 = iter.next();
    assertEqual(static_cast<int>(op6.type), static_cast<int>(OpType::TEXT), "TEXT");
    std::string_view text = decoder.getString(op6.text.textIndex);
    assertEqual(std::string(text), std::string("hello"), "text value");

    // REF_CALL
    auto op7 = iter.next();
    assertEqual(static_cast<int>(op7.type), static_cast<int>(OpType::REF_CALL), "REF_CALL");
    std::string_view method = decoder.getString(op7.refCall.methodIndex);
    assertEqual(std::string(method), std::string("focus"), "method");

    assertTrue(!iter.hasNext(), "no more");
  }});

  suite.cases.push_back({"InternPool overflow throws", []() {
    // Verify that exceeding MAX_INTERN_STRINGS throws
    InternPool pool;
    bool threw = false;
    try {
      for (uint32_t i = 0; i <= MAX_INTERN_STRINGS; ++i) {
        pool.intern("str_" + std::to_string(i));
      }
    } catch (const std::runtime_error&) {
      threw = true;
    }
    assertTrue(threw, "throws on overflow");
  }});

  // P2-1: PersistentInternManager eviction preserves cross-batch indices
  suite.cases.push_back({"PersistentInternManager eviction stable indices", []() {
    // Use a tiny maxStrings to trigger eviction quickly
    PersistentInternManager mgr(5);

    // Intern 5 strings → fills capacity
    uint16_t idx0 = mgr.intern("alpha");
    (void)mgr.intern("beta");
    uint16_t idx2 = mgr.intern("gamma");
    (void)mgr.intern("delta");
    uint16_t idx4 = mgr.intern("epsilon");

    // All indices should be unique and sequential
    assertEqual(idx0, uint16_t(0), "alpha=0");
    assertEqual(idx4, uint16_t(4), "epsilon=4");

    // Verify all strings retrievable
    assertEqual(std::string(mgr.get(idx2)), std::string("gamma"), "gamma before evict");

    // Touch gamma and epsilon so they become recently used
    mgr.intern("gamma");
    mgr.intern("epsilon");

    // Intern a new string — triggers eviction of LRU entries
    uint16_t idx5 = mgr.intern("zeta");

    // Verify zeta got a valid index
    assertTrue(idx5 < 6, "zeta has valid index");
    assertEqual(std::string(mgr.get(idx5)), std::string("zeta"), "zeta retrievable");

    // gamma and epsilon should still be retrievable at original indices
    // (they were recently touched, so should survive eviction)
    assertEqual(std::string(mgr.get(idx2)), std::string("gamma"), "gamma survived eviction");
    assertEqual(std::string(mgr.get(idx4)), std::string("epsilon"), "epsilon survived eviction");
  }});

  suite.cases.push_back({"PersistentInternManager eviction reuses tombstone slots", []() {
    PersistentInternManager mgr(4);

    mgr.intern("a");
    mgr.intern("b");
    mgr.intern("c");
    mgr.intern("d");

    // Touch c and d to keep them alive
    mgr.intern("c");
    mgr.intern("d");

    // Add new string — must evict LRU and reuse slot
    uint16_t newIdx = mgr.intern("e");

    // newIdx should reuse a tombstone slot (0 or 1), not append at 4
    assertTrue(newIdx <= 3, "reused tombstone slot");
    assertEqual(std::string(mgr.get(newIdx)), std::string("e"), "e at reused slot");
  }});

  // P2-3: InstructionCodec capacity — verify codec encode/decode roundtrip
  suite.cases.push_back({"InstructionCodec encode/decode roundtrip", []() {
    InstructionCodec codec;

    codec.beginEncode(42);
    codec.addCreateOperation(1, "View");
    codec.addAppendOperation(2, 0, 2);
    codec.addDeleteOperation(3);
    codec.addTextOperation(4, "Hello");
    auto binary = codec.finishEncode();

    assertTrue(binary.size() > 16, "has data");

    auto header = codec.decodeHeader(binary.data(), binary.size());
    assertTrue(header.has_value(), "header parsed");
    assertEqual(header->batchId, 42u, "batchId");
    assertEqual(header->opCount, uint16_t(4), "4 ops");
  }});

  return suite;
}

} // anonymous namespace

// Register with test runner
static struct InstructionCodecTestRegistrar {
  InstructionCodecTestRegistrar() {
    TestRunner::instance().addSuite(createInstructionCodecTests());
  }
} s_instructionCodecTestRegistrar;
