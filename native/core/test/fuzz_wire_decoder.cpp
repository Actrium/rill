// ============================================================================
// fuzz_wire_decoder.cpp  —  STANDALONE differential-fuzz driver (NEW; opt-in)
//
// NOT part of the normal test suite (has its own main(); not in Makefile's
// TEST_SOURCES). Built + run only via test/fuzz.mk, which compiles it together
// with ../src/protocol/WireDecoder.cpp under AddressSanitizer + UBSan and with
// RILL_WIP_BINARY_PROTOCOL=1.
//
// ROLE IN THE DIFFERENTIAL HARNESS
//   This process is the SINGLE, deterministic corpus GENERATOR, so the TS side
//   and the C++ side decode byte-for-byte identical inputs (no PRNG-drift risk
//   between two languages). For a run of N iterations it:
//     1. builds input #i (uniform-random buffer, or a mutation of a golden seed:
//        bit flips, byte subst, truncation, trailing-byte append, length-field
//        tamper, count inflation, tag corruption, reserved-byte tamper, header
//        corruption) — the seed corpus is the 4 golden vectors from
//        contracts/op-batch-wire.golden.json;
//     2. feeds it to rill::protocol::wire::WireDecoder (under ASan: any OOB /
//        UAF / UB in the decoder aborts the process = a CONFIRMED crash bug);
//     3. writes the raw bytes to <corpus.bin> (length-prefixed) and a canonical
//        result line to <cpp.results>: "A\t<canonical>" on accept, "R" on
//        reject. On accept it re-serialises EVERY decoded field — walking every
//        zero-copy string_view — so ASan also validates the views are in-bounds.
//
//   The TS driver (src/host/wasm-guest/wire-decoder.fuzz.ts) then decodes the
//   same corpus.bin with the TS decoder, builds the SAME canonical strings, and
//   diffs the two result streams: TS-accepts iff C++-accepts, and on mutual
//   accept the canonical forms must be equal. Any mismatch is a CONFIRMED drift.
//
// The canonical grammar here MUST stay identical to the one in the TS driver.
// ============================================================================

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cinttypes>
#include <map>
#include <string>
#include <vector>

#include "../src/protocol/WireDecoder.h"

using namespace rill::protocol::wire;

// --------------------------------------------------------------------------
// Deterministic PRNG (splitmix64) — identical stream for a given seed so a
// reported divergence is exactly reproducible by re-running with the same seed.
// --------------------------------------------------------------------------
namespace {

struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed) {}
  uint64_t next() {
    uint64_t z = (s += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
  }
  uint32_t below(uint32_t n) { return n == 0 ? 0 : static_cast<uint32_t>(next() % n); }
  uint8_t byte() { return static_cast<uint8_t>(next() & 0xff); }
};

// The 4 golden vectors (contracts/op-batch-wire.golden.json), as hex, are the
// mutation seed corpus. Copied verbatim; the harness never hand-rolls a batch.
const char* kGoldenHex[] = {
    // empty-batch
    "52494c4c0100000000000000000000000000",
    // one-create
    "52494c4c0100010000000100000000000100040056696577010100000000000000",
    // setprop-repeated-key
    "52494c4c01000200000002000000000003000900636c6173734e616d6501006101006"
    "202010000000100000006010000000202000000010000000602000000",
    // mixed-five-ops
    "52494c4c0100030000000500000000000600040056696577020069640400726f6f7404"
    "00546578740200486904006d61696e0101000000000001000100060200010200000003"
    "00000004000000000100000002000000080200000004000201000000010001000605000000",
};
constexpr int kGoldenCount = 4;

std::vector<uint8_t> fromHex(const char* hex) {
  std::vector<uint8_t> out;
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (const char* p = hex; p[0] && p[1]; p += 2) {
    out.push_back(static_cast<uint8_t>((nib(p[0]) << 4) | nib(p[1])));
  }
  return out;
}

void appendHex(std::string& out, const uint8_t* data, size_t len) {
  static const char* d = "0123456789abcdef";
  for (size_t i = 0; i < len; ++i) {
    out.push_back(d[data[i] >> 4]);
    out.push_back(d[data[i] & 0x0f]);
  }
}
std::string hexOf(std::string_view sv) {
  std::string out;
  appendHex(out, reinterpret_cast<const uint8_t*>(sv.data()), sv.size());
  return out;
}

// --------------------------------------------------------------------------
// Canonical serialization of a decoded batch. MUST match the TS driver byte
// for byte. Strings are hex-encoded (delimiter-safe); floats/timestamps are the
// raw 64-bit IEEE pattern (exact, formatting-independent); objects/props are
// normalised to JS-object semantics (sort keys by raw bytes, last-write-wins on
// duplicate keys) so the JS decoder's key ordering / dedup is not a false drift.
// --------------------------------------------------------------------------

std::string bitsHexOfDouble(double d) {
  uint64_t bits;
  std::memcpy(&bits, &d, sizeof(bits));
  char buf[17];
  std::snprintf(buf, sizeof(buf), "%016" PRIx64, bits);
  return std::string(buf);
}

std::string cvValue(const WireValue& v);

// keyed(entries) → sorted, last-write-wins "k<hexkey>=<cval>,..." (std::map keeps
// keys sorted by raw bytes; assigning in wire order yields last-write-wins).
std::string keyedInner(const std::vector<std::pair<std::string_view, WireValue>>& entries) {
  std::map<std::string, std::string> m;
  for (const auto& e : entries) m[std::string(e.first)] = cvValue(e.second);
  std::string out;
  bool first = true;
  for (const auto& kv : m) {
    if (!first) out.push_back(',');
    first = false;
    out.push_back('k');
    appendHex(out, reinterpret_cast<const uint8_t*>(kv.first.data()), kv.first.size());
    out.push_back('=');
    out += kv.second;
  }
  return out;
}

std::string cvValue(const WireValue& v) {
  switch (v.tag) {
    case ValueTag::Null: return "N";
    case ValueTag::Undefined: return "U";
    case ValueTag::BoolFalse: return "b0";
    case ValueTag::BoolTrue: return "b1";
    // Numbers are canonicalised by their IEEE-754 double VALUE, not by tag: the
    // TS decoder collapses INT32 and FLOAT64 into one JS `number`, so INT32 5 and
    // FLOAT64 5.0 are the same decoded value on the JS host. Comparing by double
    // bits reflects that (and stays exact / formatting-independent).
    case ValueTag::Int32: return "#" + bitsHexOfDouble(static_cast<double>(v.int32Value));
    case ValueTag::Float64: return "#" + bitsHexOfDouble(v.doubleValue);
    case ValueTag::String: return "s" + hexOf(v.str);
    case ValueTag::Function: return "fn" + hexOf(v.str);
    case ValueTag::Promise: return "pr" + hexOf(v.str);
    case ValueTag::Object: return "o{" + keyedInner(v.objectEntries) + "}";
    case ValueTag::Array: {
      std::string out = "a[";
      for (size_t i = 0; i < v.arrayItems.size(); ++i) {
        if (i) out.push_back(',');
        out += cvValue(v.arrayItems[i]);
      }
      return out + "]";
    }
    case ValueTag::Set: {
      std::string out = "S[";
      for (size_t i = 0; i < v.arrayItems.size(); ++i) {
        if (i) out.push_back(',');
        out += cvValue(v.arrayItems[i]);
      }
      return out + "]";
    }
    case ValueTag::Map: {
      std::string out = "m[";
      for (size_t i = 0; i < v.mapEntries.size(); ++i) {
        if (i) out.push_back(',');
        out += "(" + cvValue(v.mapEntries[i].first) + "~" + cvValue(v.mapEntries[i].second) + ")";
      }
      return out + "]";
    }
    case ValueTag::Date: {
      // Match the TS decoder's observable: new Date(ms) TimeClips to an integral
      // ms (ToInteger, truncation toward zero). A C++ cast to int64 truncates
      // toward zero identically. Both accept only finite, in-range ms.
      long long ms = static_cast<long long>(v.doubleValue);
      return "d" + std::to_string(ms);
    }
    case ValueTag::Error:
      return "e(" + hexOf(v.errorName) + "," + hexOf(v.errorMessage) + "," + hexOf(v.errorStack) + ")";
    case ValueTag::Regexp:
      return "r(" + hexOf(v.regexpSource) + "," + hexOf(v.regexpFlags) + ")";
  }
  return "?";
}

std::string tsBitsOfU64(uint64_t ts) {
  // TS reads u64 as (lo + hi * 2^32) in double; mirror the exact same arithmetic
  // and emit the resulting double's raw bits so large timestamps agree exactly.
  uint32_t lo = static_cast<uint32_t>(ts & 0xffffffffu);
  uint32_t hi = static_cast<uint32_t>(ts >> 32);
  double d = static_cast<double>(lo) + static_cast<double>(hi) * 4294967296.0;
  return bitsHexOfDouble(d);
}

// props uses the same keyed normalisation; wrap in a helper so CREATE/UPDATE
// share it.
std::string keyedFromProps(const std::vector<WireProp>& props) {
  std::vector<std::pair<std::string_view, WireValue>> entries;
  entries.reserve(props.size());
  for (const auto& p : props) entries.emplace_back(p.key, p.value);
  return keyedInner(entries);
}

std::string opCanonical(const WireOp& op, bool hasTimestamps) {
  std::string out;
  const std::string id = std::to_string(op.id);
  switch (op.kind) {
    case OpKind::Create:
      out = "C" + id + " t=" + hexOf(op.type) + " p={" + keyedFromProps(op.props) + "}";
      break;
    case OpKind::Update: {
      out = "U" + id + " p={" + keyedFromProps(op.props) + "} rm=[";
      for (size_t i = 0; i < op.removed.size(); ++i) {
        if (i) out.push_back(',');
        out += hexOf(op.removed[i]);
      }
      out += "]";
      break;
    }
    case OpKind::Delete:
      out = "D" + id;
      break;
    case OpKind::Append:
      out = "A" + id + " " + std::to_string(op.parentId) + " " + std::to_string(op.childId);
      break;
    case OpKind::Insert:
      out = "I" + id + " " + std::to_string(op.parentId) + " " + std::to_string(op.childId) +
            " " + std::to_string(op.index);
      break;
    case OpKind::Remove:
      out = "R" + id + " " + std::to_string(op.parentId) + " " + std::to_string(op.childId);
      break;
    case OpKind::Reorder: {
      out = "O" + id + " " + std::to_string(op.parentId) + " [";
      for (size_t i = 0; i < op.childIds.size(); ++i) {
        if (i) out.push_back(',');
        out += std::to_string(op.childIds[i]);
      }
      out += "]";
      break;
    }
    case OpKind::Text:
      out = "T" + id + " " + hexOf(op.text);
      break;
    case OpKind::RefCall: {
      out = "K" + id + " m=" + hexOf(op.method) + " c=" + hexOf(op.callId) + " args=[";
      for (size_t i = 0; i < op.args.size(); ++i) {
        if (i) out.push_back(',');
        out += cvValue(op.args[i]);
      }
      out += "]";
      break;
    }
  }
  if (hasTimestamps && op.timestamp.has_value()) {
    out += " ts=" + tsBitsOfU64(*op.timestamp);
  }
  return out;
}

std::string batchCanonical(const WireBatch& b) {
  std::string out = "V" + std::to_string(b.version) + " B" + std::to_string(b.batchId) +
                    " F" + std::to_string(static_cast<int>(b.flags)) + " ops=" +
                    std::to_string(b.ops.size()) + " [";
  const bool hasTs = b.hasTimestamps();
  for (size_t i = 0; i < b.ops.size(); ++i) {
    if (i) out += " ; ";
    out += opCanonical(b.ops[i], hasTs);
  }
  out += "]";
  return out;
}

// --------------------------------------------------------------------------
// Mutation strategies. Each takes a copy of a golden seed (or produces random
// bytes) and returns the input buffer for one iteration.
// --------------------------------------------------------------------------

std::vector<uint8_t> genInput(Rng& rng, const std::vector<std::vector<uint8_t>>& seeds) {
  // Strategy weights chosen so mutation-of-valid dominates (deep coverage of the
  // decoder past the header) while uniform-random still probes the cold paths.
  uint32_t strat = rng.below(11);

  // Uniform-random buffer (may still, rarely, be a valid header).
  if (strat == 0) {
    uint32_t n = rng.below(220);
    std::vector<uint8_t> buf(n);
    for (uint32_t i = 0; i < n; ++i) buf[i] = rng.byte();
    return buf;
  }

  std::vector<uint8_t> buf = seeds[rng.below(static_cast<uint32_t>(seeds.size()))];

  switch (strat) {
    case 1:
      // Verbatim golden — baseline: MUST both-accept and canonical-match.
      return buf;
    case 2: {
      // Bit flips (1..8).
      uint32_t flips = 1 + rng.below(8);
      for (uint32_t i = 0; i < flips && !buf.empty(); ++i) {
        uint32_t pos = rng.below(static_cast<uint32_t>(buf.size()));
        buf[pos] ^= static_cast<uint8_t>(1u << rng.below(8));
      }
      return buf;
    }
    case 3: {
      // Byte-value substitutions (1..6).
      uint32_t subs = 1 + rng.below(6);
      for (uint32_t i = 0; i < subs && !buf.empty(); ++i) {
        buf[rng.below(static_cast<uint32_t>(buf.size()))] = rng.byte();
      }
      return buf;
    }
    case 4: {
      // Truncation to a random shorter length.
      if (!buf.empty()) buf.resize(rng.below(static_cast<uint32_t>(buf.size())));
      return buf;
    }
    case 5: {
      // Append random trailing bytes (probes the trailing-bytes seam).
      uint32_t extra = 1 + rng.below(24);
      for (uint32_t i = 0; i < extra; ++i) buf.push_back(rng.byte());
      return buf;
    }
    case 6: {
      // Length-field tamper: overwrite a random 2-byte window with a random u16
      // (targets intern byteLen / collection counts / opCount / internCount).
      if (buf.size() >= 2) {
        uint32_t pos = rng.below(static_cast<uint32_t>(buf.size() - 1));
        uint16_t val = static_cast<uint16_t>(rng.next());
        buf[pos] = static_cast<uint8_t>(val & 0xff);
        buf[pos + 1] = static_cast<uint8_t>(val >> 8);
      }
      return buf;
    }
    case 7: {
      // Count inflation: bump opCount (offset 10) or internCount (offset 16).
      uint32_t off = (rng.below(2) == 0) ? 10u : 16u;
      if (buf.size() >= off + 2) {
        uint16_t val = static_cast<uint16_t>(1 + rng.below(4000));
        buf[off] = static_cast<uint8_t>(val & 0xff);
        buf[off + 1] = static_cast<uint8_t>(val >> 8);
      }
      return buf;
    }
    case 8: {
      // Tag/opcode corruption: replace a random byte with a small value in the
      // opcode/value-tag range (0x00..0x20), incl. unknown tags.
      if (!buf.empty()) buf[rng.below(static_cast<uint32_t>(buf.size()))] = static_cast<uint8_t>(rng.below(0x21));
      return buf;
    }
    case 9: {
      // Reserved-byte tamper: set one of reserved[3] (offsets 13/14/15) nonzero.
      if (buf.size() >= 16) {
        uint32_t off = 13 + rng.below(3);
        buf[off] = static_cast<uint8_t>(1 + rng.below(255));
      }
      return buf;
    }
    case 10: {
      // Header corruption: magic (0..3) or version (4..5).
      uint32_t off = rng.below(6);
      if (buf.size() > off) buf[off] = rng.byte();
      return buf;
    }
  }
  return buf;
}

} // namespace

int main(int argc, char** argv) {
  // Args: <iterations> <seed> <corpus_out> <results_out>
  uint64_t iterations = 100000;
  uint64_t seed = 0xC0FFEEULL;
  std::string corpusPath = "fuzz_corpus.bin";
  std::string resultsPath = "fuzz_cpp.results";
  if (argc > 1) iterations = strtoull(argv[1], nullptr, 10);
  if (argc > 2) seed = strtoull(argv[2], nullptr, 10);
  if (argc > 3) corpusPath = argv[3];
  if (argc > 4) resultsPath = argv[4];

  std::vector<std::vector<uint8_t>> seeds;
  for (int i = 0; i < kGoldenCount; ++i) seeds.push_back(fromHex(kGoldenHex[i]));

  FILE* corpus = std::fopen(corpusPath.c_str(), "wb");
  FILE* results = std::fopen(resultsPath.c_str(), "wb");
  if (!corpus || !results) {
    std::fprintf(stderr, "cannot open output files\n");
    return 2;
  }

  // corpus.bin header: "RFZC" magic + u32 count.
  const char magic[4] = {'R', 'F', 'Z', 'C'};
  std::fwrite(magic, 1, 4, corpus);
  uint32_t count32 = static_cast<uint32_t>(iterations);
  std::fwrite(&count32, sizeof(count32), 1, corpus);

  Rng rng(seed);
  WireDecoder decoder;

  uint64_t accepted = 0, rejected = 0;

  // First inputs = the verbatim golden seeds (guarantees the both-accept /
  // canonical-match path is always exercised, even at tiny iteration counts).
  for (uint64_t i = 0; i < iterations; ++i) {
    std::vector<uint8_t> input;
    if (i < seeds.size()) {
      input = seeds[static_cast<size_t>(i)];
    } else {
      input = genInput(rng, seeds);
    }

    // Write the raw input to the corpus (length-prefixed).
    uint32_t len = static_cast<uint32_t>(input.size());
    std::fwrite(&len, sizeof(len), 1, corpus);
    if (len) std::fwrite(input.data(), 1, len, corpus);

    // Decode (under ASan/UBSan: any OOB/UAF/UB here aborts the process).
    std::optional<WireBatch> batch = decoder.decode(input.data(), input.size());

    if (batch.has_value()) {
      ++accepted;
      // Re-serialise every field: walks every zero-copy string_view, so ASan
      // validates they are in-bounds of `input` (still alive here).
      std::string canon = batchCanonical(*batch);
      std::fputc('A', results);
      std::fputc('\t', results);
      std::fwrite(canon.data(), 1, canon.size(), results);
      std::fputc('\n', results);
    } else {
      ++rejected;
      // Emit the typed reason too ("R\t<WireError>") so the TS driver can label
      // each accept/reject divergence with WHY C++ rejected.
      std::fputc('R', results);
      std::fputc('\t', results);
      const char* why = toString(decoder.lastError());
      std::fwrite(why, 1, std::strlen(why), results);
      std::fputc('\n', results);
    }
  }

  std::fclose(corpus);
  std::fclose(results);

  std::fprintf(stderr,
               "[cpp-fuzz] iterations=%llu accepted=%llu rejected=%llu seed=%llu\n"
               "[cpp-fuzz] no ASan/UBSan abort => C++ decoder memory-safe over all inputs\n",
               static_cast<unsigned long long>(iterations),
               static_cast<unsigned long long>(accepted),
               static_cast<unsigned long long>(rejected),
               static_cast<unsigned long long>(seed));
  return 0;
}
