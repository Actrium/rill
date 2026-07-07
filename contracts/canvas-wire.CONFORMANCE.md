# canvas-wire protocol — cross-language conformance

The canvas binary wire is a **sister** to the op-batch wire (see
[`op-batch-wire.CONFORMANCE.md`](./op-batch-wire.CONFORMANCE.md)), not a superset:
op-batch carries UI-tree diffs over a retained, recursively-nested node graph;
canvas is a **flat, per-frame** draw-op sequence with no nesting and no retained
wire state. The two share the envelope *shape* and the single-source + golden-lock
*discipline*, but use **distinct magic** so a buffer meant for one decoder fails
the other's `u32` magic compare immediately.

Unlike op-batch (three codecs: Rust encoder + TS + C++ decoders), canvas has a
**two-way** lock today — a Rust **encoder** and a zero-DOM TS **decoder** — that
MUST agree byte-for-byte. Both are locked to the SAME two files and never to each
other:

- **Schema (single source of truth):** [`canvas-wire.json`](./canvas-wire.json)
- **Golden oracle (fixed vectors):** [`canvas-wire.golden.json`](./canvas-wire.golden.json)
- **Design / handshake / JS-path spec:** [`canvas-wire.DESIGN.md`](./canvas-wire.DESIGN.md)
  (folded in / cross-referenced below — §5, §6)

## The conformance chain

The golden file is the shared pivot. Each vector pairs a source `frame` (canvasId
+ frameId + op array) with its exact on-the-wire `hex`. Conformance is the closed
loop:

| # | Assertion | Where | Direction |
|---|-----------|-------|-----------|
| 1 | Rust **encoder**(source frame) == golden `hex`, byte-for-byte | `crates/rill-guest/src/canvas_encode.rs` (`golden_vectors_encode_byte_exact`) | frame → bytes |
| 2 | TS **decoder**(golden bytes) semantically == source op array | `src/host/wire/__tests__/canvas-wire-decoder.test.ts` (`toEqual(ops)`) | bytes → ops |

Because Rust emits *exactly* the golden bytes and the decoder consumes *exactly*
those same bytes and reconstructs the *same* documented op array, both agree on
the same bytes AND the same fields transitively. Any byte- or field-level
disagreement fails a row above — that is the drift alarm. The TS decoder re-checks
all four decode entry points against every vector (`decodeCanvasBatch` one-shot,
`decodeCanvasFrame`, `peekCanvasHeader`, and the `decodeCanvasBatchStreaming`
iterator), so they cannot drift from each other either.

Locking notes (so the pivot cannot silently rot):
- The Rust codec constants (magic, protocol version, opcodes, flags, limits) are
  **generated** from `canvas-wire.json` by `crates/rill-guest/build.rs`
  (`generate_canvas_contract`), so a renamed/removed key fails the build. `MAGIC`
  is derived from the schema's `magic.hex` and its little-endian bytes are
  asserted to spell `magic.asciiBytes` at build time — any edit to either field
  fails the build loudly.
- The Rust and TS tests read `canvas-wire.golden.json` **directly**. The TS
  decoder pins the same constants as documented literals (§4); a drift below any
  cap would fail the golden `at-limit-ops` (maxOps=20000) vector, and a magic
  drift would fail every vector — so the golden pivot enforces the TS side too.
- The golden file is regenerated (never hand-edited) via
  `RILL_REGEN_CANVAS_GOLDEN=1 cargo test -p rill-guest --features wip-binary-protocol`;
  the Rust encoder is the oracle.

## How to run both (Linux)

```sh
# 1. Rust encoder → golden hex (+ all cap / negative cases)
cd /ext/rill/crates && cargo test -p rill-guest --features wip-binary-protocol

# 2. TS zero-DOM decoder ← golden bytes (+ fail-closed + cross-magic)
cd /ext/rill && bun test src/host/wire

# 3. Capability handshake round-trip + JSON fallback + default-stays-JSON
cd /ext/rill && bun test src/host/wasm-guest
```

Both codecs are WORK IN PROGRESS and gated OFF in shipped builds:
- Rust: `--features wip-binary-protocol` (Cargo feature, default off). The default
  `canvas::draw` path emits JSON, byte-identical to before.
- TS: the decoder is exported (`rill/wire`) but no live receive path imports it;
  the host `onHostCall` only diverts to a binary-aware handler when a payload
  starts with the `RCNV` magic, which the default guest never emits.

## 1. The envelope (mirrors op-batch's shape)

A frame is: **16-byte fixed header** → inline `canvasId` (u16 len + UTF-8) →
per-frame intern table (u16 count, then u16-len + UTF-8 entries) → ops.

Header field order: `magic u32 · version u16 · frameId u32 · opCount u32 ·
flags u8 · reserved u8[1]`. `opCount` is a **u32 in the header** so the decoder
validates it against `maxOps` **before** the decode loop — the
decode-amplification guard (§3).

The intern table is **per-frame** (starts empty each frame): canvas is stateless
per-frame, unlike op-batch's cross-batch persistent table. The Rust `Encoder`
clears its color intern table at the start of every `encode_frame`; the TS decoder
builds a fresh table per frame.

## 2. The opcode table (u8 tag + fixed fields)

Every op is a leading u8 opcode then fixed fields in wire order. All numbers are
**f64 little-endian**. Order matches the guest `DrawList` builder and the JSON
emission (`fillText` fields are `x, y, text`). No per-op id, no trailer.

| # | op | fields (wire order) | bytes after opcode |
|---|-----|---------------------|--------------------|
| 1 | beginPath | — | 0 |
| 2 | closePath | — | 0 |
| 3 | moveTo | x f64, y f64 | 16 |
| 4 | lineTo | x f64, y f64 | 16 |
| 5 | rect | x,y,w,h f64 | 32 |
| 6 | arc | x,y,r,start,end f64, ccw u8 | 41 |
| 7 | fill | — | 0 |
| 8 | stroke | — | 0 |
| 9 | fillRect | x,y,w,h f64 | 32 |
| 10 | strokeRect | x,y,w,h f64 | 32 |
| 11 | clearRect | x,y,w,h f64 | 32 |
| 12 | setFillStyle | color internRef u16 | 2 |
| 13 | setStrokeStyle | color internRef u16 | 2 |
| 14 | setLineWidth | w f64 | 8 |
| 15 | fillText | x f64, y f64, textLen u32 + UTF-8 | 20 + len |
| 16 | save | — | 0 |
| 17 | restore | — | 0 |
| 18 | translate | x f64, y f64 | 16 |
| 19 | scale | x f64, y f64 | 16 |
| 20 | rotate | angle f64 | 8 |
| 21 | setTransform | a,b,c,d,e,f f64 | 48 |

**Per-field encoding decisions** (annotated in the schema):
- `setFillStyle` / `setStrokeStyle` `color` → **INTERNED** u16 internRef (colors
  repeat heavily in a frame).
- `fillText` `text` → **INLINE** u32 len + UTF-8 (high cardinality, do not intern).
- `arc` `ccw` → **u8 bool** (only `0` / `1` valid; anything else → `bad-opcode`).
- Numbers are all f64 LE and MUST be finite (NaN/±Inf → `non-finite`). A reserved
  `f32` type-atom and a `COORDS_F32=1` frame flag are named-but-rejected in v1, so
  future half-precision is an additive flag flip, not a redesign.

## 3. The golden vectors (27)

`canvas-wire.golden.json` carries **27 byte-exact vectors** (Rust encoder is the
oracle; TS decoder reconstructs structure-exact). They are:

- `empty` — header + empty intern table + zero ops (fixes the envelope layout).
- One per op — all 21 opcodes, with `arc` covered twice (`arc-cw`, `arc-ccw`) for
  both `ccw` values.
- `repeated-colors` — 3× `#f00` collapses to a **single** intern entry (proves the
  per-frame color table).
- `fill-text-multibyte` — `café ☕ 日本語`, byte-length ≠ char count (proves UTF-8
  byte accounting on the inline text).
- `mixed-frame` — a realistic sparkline (save/transform/path/stroke/fillText).
- `at-limit-ops` — exactly `maxOps` = 20000 ops, the boundary the decoder
  pre-checks (§3 budget guard). This one vector dominates the ~430 KB file size;
  the readable vectors are one-per-line.

## 4. Constant-flow check (no drift)

Every fixed constant resolves to the SAME value in both codecs, sourced from the
single schema. Rust reads them from `canvas-wire.json` at build time; TS pins the
same literals and the golden `at-limit-ops` / cross-magic vectors would fail on
any drift.

| Constant | Schema (`canvas-wire.json`) | Rust | TypeScript |
|----------|-----------------------------|------|------------|
| magic | `magic.hex` = `0x564e4352` (`RCNV`, u32le `1447969618`) | `MAGIC = 1447969618` (build.rs, from `magic.hex`, LE bytes asserted == `asciiBytes`) | `CANVAS_MAGIC = 0x564e4352` |
| version | `protocolVersion` = `1` | `PROTOCOL_VERSION = 1` | `PROTOCOL_VERSION = 1` |
| maxOps | `limits.maxOps.value` = `20000` | `limits::MAX_OPS = 20000` (build.rs, from `limits`) | `MAX_OPS = 20000` |
| maxInternStrings | `limits.maxInternStrings.value` = `4096` | `limits::MAX_INTERN_STRINGS = 4096` | `MAX_INTERN_STRINGS = 4096` |
| maxStringBytes | `limits.maxStringBytes.value` = `256` | `limits::MAX_STRING_BYTES = 256` | `MAX_STRING_BYTES = 256` |
| maxTextBytes | `limits.maxTextBytes.value` = `8192` | `limits::MAX_TEXT_BYTES = 8192` | `MAX_TEXT_BYTES = 8192` |
| maxBatchBytes | `limits.maxBatchBytes.value` = `8388608` | `limits::MAX_BATCH_BYTES = 8388608` | `MAX_BATCH_BYTES = 8*1024*1024` |

Because Rust's constants are **generated** from the schema (magic derived from
`magic.hex`, every `limits.*` read straight from `limits` and emitted as a
`SCREAMING_SNAKE` const), a renamed/removed key or a value change fails the build.
The constants cannot drift from the contract.

## 5. Fail-closed contract (caps + frame atomicity + budget precheck)

**Fail-closed** means: on any breach the codec aborts the WHOLE frame and lets
NOTHING partial cross the seam. The encoder throws *before/without* emitting a
truncated buffer; the decoder throws *and discards the whole frame* (with a
reason) rather than replaying a partial op list. **Frame atomicity:** the decoder
decodes the entire frame into an op array and replays it only if the whole frame
is valid — never a half-frame.

Canvas has **no** recursive/nested value trees, so there is deliberately **no**
`maxValueDepth` / `maxTotalElements`: the decoder's entire allocation footprint is
bounded by (`opCount <= maxOps`) fixed-size records plus inline text/colors, the
whole thing under `maxBatchBytes` — and `opCount` is validated against `maxOps`
**before** the loop, so a small buffer can never claim a huge op stream
(decode-amplification defense).

Every cap maps to a stable `reason` token (schema `reasons` block), surfaced to
the platform as `{ ok:false, dropped:<opCount>, reason:<token> }`:

| reason | fired when |
|--------|-----------|
| `bad-magic` | first u32 ≠ `RCNV` (also catches a cross-fed op-batch buffer) |
| `bad-version` | header version ≠ `1` |
| `reserved-flag` | any reserved / unknown flag bit set (e.g. `COORDS_F32`) |
| `op-budget` | `header.opCount > maxOps` (checked BEFORE the loop) |
| `frame-too-big` | buffer length > `maxBatchBytes` |
| `intern-overflow` | intern count > `maxInternStrings` |
| `string-too-big` | a canvasId or color UTF-8 length > `maxStringBytes` |
| `text-too-big` | a fillText UTF-8 length > `maxTextBytes` |
| `bad-intern-ref` | an internRef ≥ the table count |
| `bad-opcode` | unknown opcode, or `arc.ccw` ∉ {0,1} |
| `non-finite` | any f64 is NaN / ±Inf |
| `truncated` | buffer underruns a declared field, or has trailing bytes (strict full consumption) |

The Rust encoder's typed `EncodeError` (`TooManyOps`, `InternTableOverflow`,
`StringTooLong`, `TextTooLong`, `FrameTooLarge`, `NonFiniteNumber`) maps 1:1 onto
these tokens; the TS `CanvasDecodeError` carries the token directly. Cap and
negative cases are covered on both sides (Rust: `op_budget_cap_is_enforced`,
`oversized_color`/`oversized_canvas_id`, `oversized_text`, `intern_table_overflow`,
`oversized_frame`, `non_finite_numbers`, `intern_table_is_per_frame`; TS: a typed
negative per reason, plus the streaming form rejecting `op-budget` up front).

## 6. Capability handshake (guest learns it may send binary)

Full rationale in [`canvas-wire.DESIGN.md`](./canvas-wire.DESIGN.md) §1; the
concrete wiring:

- One additive host method **`host:canvas.getInfo() → { binaryDraw:boolean,
  wireVersion:number }`**. The guest `await`s it **once** and caches the answer
  (`host_supports_binary()` in `crates/rill-guest/src/lib.rs`, gated on
  `wip-binary-protocol`).
- Binary is used **iff** the feature is compiled **and** `ok==1` **and**
  `binaryDraw==true` **and** `wireVersion` == the encoder's `WIRE_VERSION`. Any
  non-affirmative answer — an **old host that never registered `getInfo`** resolves
  `ok=0`, a missing field, `false`, or a version mismatch — ⇒ the guest stays on
  JSON. Graceful degrade, no flag-day, no `rill_abi_version` bump (this is
  channel selection, not an ABI break).
- Both encodings share the single `draw` method. The host forks on the **first
  payload byte**: `0x52` (`R` of `RCNV`) → binary handler; `0x7B` (`{`) → the
  legacy `JSON.parse` path, byte-identical to before. The carve-out is keyed to
  the full 4-byte magic, so no existing module's trust boundary is weakened and
  genuinely malformed input still fails closed (`ok=0`).
- **Promotion = flip the default.** During WIP the guest defaults to JSON even
  when the host advertises binary, so the decoder bakes with no live traffic
  depending on it. Going live is a one-line default flip in the guest's
  encoder-selection — not a wire change, not a version bump.

The handshake is proven end-to-end by three fixture tests
(`src/host/wasm-guest/__tests__/canvas-guests.test.ts`):
- **Round-trip** — an advertising host (`getInfo → {binaryDraw:true,
  wireVersion:1}`) + the `canvas-binary-guest.wasm` fixture ⇒ the guest sends a
  **binary** frame; the host decodes it with `decodeCanvasFrame` and the replayed
  op array `toEqual`s the expected ops; the guest probed exactly once.
- **Fallback** — a host that never registers `getInfo` (old host) + the same wip
  guest ⇒ probe resolves `ok=0` ⇒ the guest sends **JSON**, same op sequence.
- **Default-stays-JSON** — the `canvas-guest.wasm` fixture built **without** wip,
  against an advertising host ⇒ still JSON, never probes — promotion is a guest
  rebuild, not a host advertisement.

## 7. JS / QuickJS forward path (spec, nothing built)

The contract is guest-agnostic by construction — nothing above is specific to the
Rust guest. Two forward routes carry a non-Rust (JS / QuickJS) guest to binary
without changing the wire (design detail in `canvas-wire.DESIGN.md` §2):

- **Route A (preferred): host-side wrapping at the shell-RPC boundary.** The
  QuickJS guest keeps emitting JSON; the host transcodes JSON → binary once into
  the same decoder. The platform stated this is sufficient — no guest change, no
  new encoder.
- **Route B (only if profiled): a JS encoder port** gated by the same `getInfo`
  handshake and proven byte-exact against the same golden vectors (a direct port
  of `canvas_encode.rs`, the golden test's structure the template).

Either way the wire is unchanged and this same golden file is the acceptance test.

## Current status — PASS (WIP, gated off)

Verified 2026-07-08 on Linux (rustc 1.93.0, bun 1.3.5).

| Codec / suite | Role | Result |
|---|---|---|
| Rust `rill-guest` (`--features wip-binary-protocol`) | encoder → golden hex + caps | **PASS** — 51 tests (11 new canvas: golden byte-exact, all seven caps, per-frame intern, header layout) |
| Rust `rill-guest` (default) | shipped JSON path unaffected | **PASS** — 27 tests |
| TS `canvas-wire-decoder` (`bun test src/host/wire`) | golden bytes → ops + fail-closed + cross-magic | **PASS** — 163 tests (52 canvas: 27 golden vectors decode to exact ops across all four entry points, a typed negative per reason, cross-magic both directions) |
| TS `bun test src/host/wasm-guest` | handshake round-trip + JSON fallback + default-stays-JSON | **PASS** — 70 tests (incl. the three canvas handshake fixtures) |
| `bunx tsc --noEmit` | typecheck | **PASS** — exit 0 |

**Cross-magic (both directions), proven:** a canvas (`RCNV`) buffer fed to the
op-batch decoder throws `WireDecodeError`; an op-batch (`RILL`) buffer fed to the
canvas decoder throws `CanvasDecodeError('bad-magic')`. The two magics differ at
byte 1 (`0x43 'C'` vs `0x49 'I'`), so the `u32` compare rejects immediately,
before any field is read.

The zero-DOM TS decoder is on the public export surface (`import { decodeCanvasBatch }
from 'rill/wire'`); the Rust encoder and the whole binary path remain WIP and
default-off. Promotion (flip the guest default) remains the platform's call under
its gradual-rollout model.
