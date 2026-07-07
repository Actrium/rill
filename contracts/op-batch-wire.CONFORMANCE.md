# op-batch wire protocol — cross-language conformance

This binary protocol has three independent codecs that MUST agree byte-for-byte.
The whole point of the single-source schema is to catch cross-language drift, so
each codec is locked to the SAME two files and never to a peer implementation:

- **Schema (single source of truth):** [`op-batch-wire.json`](./op-batch-wire.json)
- **Golden oracle (fixed vectors):** [`op-batch-wire.golden.json`](./op-batch-wire.golden.json)

## The conformance chain

The golden file is the shared pivot. Each vector pairs a source `batch` (guest
JSON) with its exact on-the-wire `hex`. Conformance is the closed loop:

| # | Assertion | Where | Direction |
|---|-----------|-------|-----------|
| 1 | Rust **encoder**(source batch) == golden `hex`, byte-for-byte | `crates/rill-guest/src/wire_encode.rs` (`golden_vectors_encode_byte_exact`) | batch → bytes |
| 2 | TS **decoder**(golden bytes) semantically == source batch | `src/host/wasm-guest/__tests__/wire-decoder.test.ts` (`toEqual(operations)`) | bytes → batch |
| 3 | C++ **decoder**(golden bytes) semantically == source batch | `native/core/test/test_wire_decoder.cpp` (`golden: *`) | bytes → batch |

Because Rust emits *exactly* the golden bytes and both decoders consume *exactly*
those same bytes and reconstruct the *same* documented batch, all three agree on
the same bytes AND the same fields transitively. Any byte- or field-level
disagreement between languages fails at least one row above — that is the drift
alarm.

Locking notes (so the pivot cannot silently rot):
- Rust and TS tests read `op-batch-wire.golden.json` **directly**; the Rust codec
  constants (magic, opcodes, value tags, flags, limits) are **generated** from
  `op-batch-wire.json` by `crates/rill-guest/build.rs`, so a renamed/removed key
  fails the build.
- The C++ test hard-copies the golden hex literals; those copies are verified
  byte-identical to the golden file as part of this conformance run (see below).

## How to run all three (Linux)

```sh
# 1. Rust encoder → golden hex
cd /ext/rill/crates && cargo test -p rill-guest --features wip-binary-protocol

# 2. TS streaming decoder ← golden bytes
cd /ext/rill && bun test src/host/wasm-guest/__tests__/wire-decoder.test.ts

# 3. C++ zero-copy decoder ← golden bytes
make -C /ext/rill/native/core test
```

All three codecs are WORK IN PROGRESS and gated OFF in shipped builds:
- Rust: `--features wip-binary-protocol` (Cargo feature, default off).
- C++: `-DRILL_WIP_BINARY_PROTOCOL=1` (the test Makefile defines it; a normal
  build compiles `WireDecoder.cpp` to an empty translation unit).
- TS: the decoder is not imported by any live receive path; the default
  `PayloadEncoding` is still `json`.

## Current status — PASS (no drift, post-fix)

Re-verified 2026-07-07 on Linux (rustc 1.93.0, g++ 13.3.0, bun 1.3.5) after
BROADENING `maxTotalElements` to charge the three non-value collections
(REORDER `childIds`, UPDATE `removedProps`, and intern-table entries) to the
SAME per-batch counter as value nodes — on top of the earlier `maxDateMs`
DATE-domain parity fix, the original value-node `maxTotalElements` cap, the
`maxValueDepth` + `magic.u32le` fixes, and the matching Rust/TS/C++ codec fixes.
All the fixes are ADDITIVE — they only introduced new fail-closed rejection
paths (container-nesting cap, the now-broadened total-element cap, and the DATE
finite+range check) and corrected the `magic.u32le` documentation decimal; they
did NOT alter the wire format. The broadening only ADDED rejection paths for
non-value collections — no encode/decode of any well-formed batch changed. The 4
golden vectors still encode/decode byte-exact in all three languages:

| Codec | Role | Result |
|-------|------|--------|
| Rust `rill-guest` | encoder → golden hex | **PASS** — 38 tests; all 4 vectors byte-exact (`golden_vectors_encode_byte_exact`); cross-batch intern stability + fail-closed (oversized string, non-finite float, `value_nesting_depth_is_enforced`, `total_value_nodes_cap_*`, the two broadened-cap cases `reorder_childids_count_toward_total_elements_cap` + `removed_props_and_intern_entries_count_toward_total_elements_cap`, `non_finite_date_is_rejected`, `out_of_range_date_is_rejected_at_cap_ok`) green |
| TypeScript `wire-decoder` | golden bytes → batch | **PASS** — 29 tests; every vector `toEqual` its source batch; fail-closed rejections incl. depth cap, both the value-node and the broadened non-value maxTotalElements cases (REORDER childIds + UPDATE removedProps over-cap, and a mixed under-cap batch), and the DATE range guard green |
| C++ `WireDecoder` | golden bytes → batch | **PASS** — 4 golden vectors + fail-closed cases incl. depth cap, the value-node total-elements cap, the broadened non-value cap (REORDER childIds + UPDATE removed refs over-cap, at-cap REORDER decodes, small mixed REORDER+UPDATE decodes), and `DATE NaN/Inf/out-of-range rejected (InvalidDate)` + `DATE at the range cap decodes`; hard-copied hex confirmed identical to the golden file (WireDecoder subsuite 23/23 green, 254/254 in the core suite, ASan-clean) |

An independent (non-codec) Python re-decode of `mixed-five-ops` reconstructs the
documented batch and consumes every byte, confirming the golden oracle itself is
sound (the decoders are not agreeing on a mis-documented vector).

### Constant-flow check (no drift)

Both fixed constants resolve to the SAME value in every codec, sourced from the
single schema:

| Constant | Schema (`op-batch-wire.json`) | Rust | TypeScript | C++ |
|----------|-------------------------------|------|------------|-----|
| magic | `magic.u32le` = `1280067922`, `magic.hex` = `0x4c4c4952` | `MAGIC = 1280067922` (build.rs, generated from `magic.hex`) | `RILL_MAGIC = 0x4c4c4952` | `kMagic = 0x4c4c4952u` |
| maxValueDepth | `limits.maxValueDepth.value` = `64` | `limits::MAX_VALUE_DEPTH = 64` (build.rs, generated from `limits`) | `MAX_VALUE_DEPTH = 64` | `kMaxValueDepth = 64u` |
| maxTotalElements | `limits.maxTotalElements.value` = `1048576` | `limits::MAX_TOTAL_ELEMENTS = 1048576` (build.rs, generated from `limits`) | `MAX_TOTAL_ELEMENTS = 1048576` | `kMaxTotalElements = 1048576u` |
| maxDateMs | `limits.maxDateMs.value` = `8640000000000000` | `limits::MAX_DATE_MS = 8640000000000000` (build.rs, generated from `limits`) | `MAX_DATE_MS = 8.64e15` | `kMaxDateMs = 8.64e15` |

`0x4c4c4952` = `1280067922` decimal, so the magic decimal, hex and every golden
vector (`52494c4c` LE) now agree. Rust's `MAGIC`, `MAX_VALUE_DEPTH` and
`MAX_TOTAL_ELEMENTS` are still generated from the schema by
`crates/rill-guest/build.rs` (magic derived from `magic.hex`, every `limits.*`
value read straight from `limits` and emitted as a `SCREAMING_SNAKE` const), so a
renamed/removed key or a value change fails the build — the constants cannot
drift from the contract.

All three codecs enforce `maxTotalElements` at the SAME total-decoded-element
boundary, and that boundary now spans EVERY element kind on ONE per-batch
counter: every value node (each scalar AND each container at every nesting
level = 1, a container counted in addition to its children), PLUS every REORDER
`childId`, PLUS every UPDATE `removedProp`/`removed` reference, PLUS every
intern-table entry — each charged exactly 1 to the same running count. Each
codec rejects fail-closed the moment that single count would exceed the cap,
BEFORE allocating the offending element. The boundary is byte-for-byte identical
across all element kinds — a batch of EXACTLY `1048576` total elements is the
last one accepted; `1048577` is the first rejected: Rust `element_count >
MAX_TOTAL_ELEMENTS` (encode, funnelled through `charge_element`), TS
`totalValues + n > MAX_TOTAL_ELEMENTS` / `++totalValues > MAX_TOTAL_ELEMENTS`
(decode), C++ `totalElements > kMaxTotalElements` (decode, via `countElements`).
Each language has at-cap-accepts / over-cap-rejects test pairs pinned to the
same `1048576` count — one driven purely by value nodes AND one driven by the
non-value collections (REORDER childIds and, for Rust/C++, UPDATE removed refs +
intern entries), proving all element kinds share the one boundary with no
drift.

### Former contract trap — RESOLVED

`op-batch-wire.json`'s `magic.u32le` decimal previously read `1280592210`
(`0x4c544952`, LE bytes `RITL`), inconsistent with `magic.hex` (`0x4c4c4952`),
`magic.asciiBytes` (`RILL`) and every golden vector. It has been corrected to
`1280067922` (`0x4c4c4952` = `RILL`), so all four now agree. The codecs never
drifted (TS/C++ hard-code `0x4c4c4952`; Rust derives from `magic.hex` and asserts
`hex` ↔ `asciiBytes`), and a future codec that naively trusts `magic.u32le` is now
also correct.

### Former memory-amplification residual — RESOLVED

`maxBatchBytes` (16 MiB) bounded only the encoded buffer, not the decoded value
tree. A small, well-formed buffer (<= 16 MiB) packed with many 1-byte values
(e.g. thousands of nested empty arrays or a flood of `NULL` scalars) inflated
into a multi-GB decoded structure — measured ~2.9 GB RSS in the C++ decoder and
~32 MB residual in TS — a resource-exhaustion DoS on the untrusted guest→host
seam that the byte cap alone could not stop.

Resolved by adding `limits.maxTotalElements = 1048576` to the schema as a second,
INNER bound (the byte cap stays as the outer bound):

- **Definition (as broadened):** the maximum total number of DECODED ELEMENTS a
  single batch may contain, counting — on ONE per-batch running count — every
  VALUE NODE at every nesting level (each scalar value AND each container
  OBJECT/ARRAY/MAP/SET = 1, a container's children counted IN ADDITION to the
  container itself), PLUS every REORDER `childId`, PLUS every UPDATE
  `removedProp`/`removed` reference, PLUS every intern-table entry — each exactly
  1. (Originally the cap charged only value nodes; it was later broadened to fold
  the three non-value collections into the same counter — see the RESOLVED note
  below.)
- **Cap:** `1048576` (~100× a realistic op-batch's element count), which bounds
  the C++ decoder's worst-case decoded footprint to ~210–220 MB (measured: the
  heaviest charged element is an OBJECT entry, a `pair<string_view, WireValue>`
  ≈200 B; add the u16-capped ops vector ~14 MB and the ≤16 MiB input buffer) —
  ~1500× under the pre-fix multi-GB unbounded DoS, and always fail-closed.
- **Enforcement:** every codec maintains ONE per-batch running count spanning all
  element kinds and rejects fail-closed (aborts the whole batch, nothing partial
  crosses the seam) the moment the count would exceed the cap, BEFORE allocating
  the offending element.

The fix is purely additive: it introduced new rejection paths only, generated
into each language from the single schema key (`MAX_TOTAL_ELEMENTS` /
`kMaxTotalElements`), and did NOT touch the wire format — the 4 golden vectors
still encode/decode byte-exact in all three codecs. Each codec carries the
PoC amplification case (over-cap rejects with `TotalElementsExceeded`) and an
at-cap boundary case (exactly `1048576` elements still decodes/encodes), for
both the value-node path AND the non-value collections.

### Former DATE-domain divergence — RESOLVED

The Rust encoder rejected only NaN/±Infinity Dates; the TS decoder additionally
rejected any `epochMs` beyond the ECMAScript Date range (±8.64e15 ms, past which
`new Date(x).toISOString()` throws); the C++ decoder accepted any `epochMs`
as-is. So the same DATE bytes could be valid to one codec and invalid to another
— a cross-language drift on the untrusted seam.

Resolved by single-sourcing the domain as `limits.maxDateMs = 8640000000000000`
and enforcing it identically everywhere: a DATE whose `epochMs` is NaN, ±Infinity,
or `|epochMs| > maxDateMs` is rejected fail-closed by the encoder
(`DateOutOfRange` / `NonFiniteNumber`), the TS decoder (`invalid Date value`), and
the C++ decoder (`InvalidDate`). A DATE exactly at the cap still round-trips. The
constant is generated into Rust (`MAX_DATE_MS`) from the schema; TS/C++ lock to
the same value. Additive — no wire-format change, golden vectors unaffected.

### Former non-value collection footprint — RESOLVED

`maxTotalElements` originally charged only VALUE NODES, leaving three non-value
counts uncharged: `REORDER.childIds` (u32 each), `UPDATE.removedProps`/`removed`
(internRef each), and the intern table. Each single op was still capped at
`maxCollectionElements` (65535, a u16 width), but the AGGREGATE across `maxOps`
was bounded only by `maxBatchBytes`, so a single well-formed 16 MiB batch packed
with these decoded to a peak of ~320–395 MB (measured: TS ~392 MB, C++ ~322 MB).
It was linear in the input (sub-GB, hard-bounded by the 16 MiB byte cap) — not
the unbounded value-tree amplification class the cap already closed — but it was
still the last decoder-allocation path not bounded by the element cap.

Resolved by BROADENING `maxTotalElements` to charge all three non-value
collections to the SAME single per-batch running count as value nodes: every
REORDER `childId`, every UPDATE `removedProp`/`removed` reference, and every
intern-table entry now costs exactly 1 on that counter, checked BEFORE the
offending op's list is allocated/reserved (so a bogus u16 count cannot
pre-allocate past the cap). The whole non-value footprint is now charged to the
cap, bounding ALL decoder allocation to the single `maxTotalElements` limit.

The broadening is purely additive — it only ADDED rejection paths for the
non-value collections; no encode/decode of any well-formed batch changed and the
wire format is untouched (the 4 golden vectors still encode/decode byte-exact in
all three codecs). It is single-sourced from the schema
(`limits.maxTotalElements`, whose `definition`/`reason`/`reject` now enumerate
all four element kinds) and generated into each codec (`MAX_TOTAL_ELEMENTS` /
`kMaxTotalElements`). Each codec adds over-cap-rejects / at-cap-accepts cases
driven purely by the non-value collections — Rust
`reorder_childids_count_toward_total_elements_cap` +
`removed_props_and_intern_entries_count_toward_total_elements_cap`; TS "REORDER
childIds over cap", "UPDATE removedProps over cap", and a mixed under-cap decode;
C++ "REORDER childIds over/at cap", "UPDATE removed refs over cap", and a small
mixed REORDER+UPDATE decode — all charging to the same `1048576` boundary as the
value-node cases, with no drift. The C++ non-value cases withhold the offending
op's element bytes entirely, proving the reject fires on the charged count
BEFORE any reserve/read (bounded RSS), and the suite is ASan-clean.
