# canvas-wire — design notes (handshake + guest-agnostic path spec)

Companion to [`canvas-wire.json`](./canvas-wire.json) (the wire contract) and the
future [`canvas-wire.golden.json`](./canvas-wire.golden.json) /
`canvas-wire.CONFORMANCE.md` (the cross-language golden lock). This file covers
the two things the schema itself does not: **how a guest learns it may send
binary** (the capability handshake) and **how a non-Rust (JS / QuickJS) guest
would emit binary in the future** (the forward path spec). No handshake code and
no JS encoder are built here — this is the concrete, unambiguous spec the next
phases implement, written now so the wire never needs a redesign for either.

The canvas contract is a **sister** to the op-batch wire, not a superset:
op-batch carries UI-tree diffs over a retained node graph (recursive
`SerializedValue` trees); canvas is a **flat, per-frame** draw-op sequence with
no nesting and no retained wire state. They share the envelope *shape* and the
single-source + golden-lock *discipline*, but use **distinct magic**
(`0x564e4352` `RCNV` vs `0x4c4c4952` `RILL`) so a buffer meant for one decoder
fails the other's `u32` magic compare immediately.

---

## 1. Capability handshake — "this host supports binary canvas batches"

### 1.1 The problem

The guest SDK's `canvas::draw` today always serialises a JSON op-list and calls
`host_call("host:canvas", "draw", {canvasId, ops:[...]})`
(`crates/rill-guest/src/lib.rs`). The host `JSON.parse`s it. We want the guest to
send the **binary** frame (`canvas-wire.json`) instead — but only to a host that
can decode it. Requirements, all mandated by the platform requirement R1
(`platform-rill-requirements-2026-07`):

- **Additive & back-compatible.** An old host that has never heard of binary
  canvas must keep receiving JSON and must not break. A new guest talking to an
  old host must fall back to JSON on its own.
- **No `rill_abi_version` bump.** The ABI wire and exports are unchanged; this is
  a *channel-selection* capability, not an ABI break. `RILL_ABI_VERSION` stays
  `1` (`crates/rill-guest/src/lib.rs:53`). Bumping it would force every host to
  re-gate every guest for an additive, opt-in encoding — exactly the flag-day the
  platform said to avoid.
- **Promotion = flip the default.** During WIP the guest defaults to JSON even
  when the host advertises binary support (so the decoder can bake without any
  live traffic depending on it). "Going live" is a one-line default flip in the
  guest encoder-selection, not a wire change and not a version bump.
- **WIP-gated.** Like the op-batch codecs, everything here ships **off**: the
  Rust encoder behind a Cargo feature, the TS decoder not on any live receive
  path, the guest default still JSON.

### 1.2 The existing handshake surface (what we build ON)

- The **native (WASM) guest** boundary is `WasmGuestHost`
  (`src/host/wasm-guest/wasm-guest-host.ts`). The guest reaches host capabilities
  only through `rill_host_call(module, method, in, cb)` dispatched via
  `createHostModuleDispatch(contract, impl)` (`src/contract/index.ts`). **The
  import model is the sandbox**: a guest can only call a `host:*` module the host
  actually registered; an unregistered module/method resolves `ok=0`
  (fail-closed) without crashing the guest — see the test "an unregistered
  host:canvas resolves ok=0 without crashing the guest".
- There is a per-guest ABI probe (`rill_abi_version()` export, read once at
  `load()`), but **no** capability/`getInfo` query exists yet on the
  `host:canvas` module. `host:canvas` currently exposes only `draw` and
  `present` (`contracts/graphics-seams.json`).

That fail-closed `ok=0`-on-unknown behaviour is the seam we lean on: **a guest
can safely *ask* whether a capability exists, and an old host simply answers "no"
by not having it.**

### 1.3 The chosen mechanism — an additive `host:canvas.getInfo` capability probe

Add ONE additive method to the `host:canvas` seam:

```
host:canvas.getInfo()  ->  { binaryDraw: boolean, wireVersion: number }
```

- **`binaryDraw`** — `true` iff this host has the binary decoder wired for the
  `draw` path. An old host does not implement `getInfo` at all, so the call
  resolves `ok=0`; the guest treats *any* non-affirmative answer (`ok=0`, missing
  field, `false`) as **"binary unsupported → use JSON."**
- **`wireVersion`** — the `canvas-wire.json` `protocolVersion` the host decodes
  (currently `1`). Lets a future host advertise a newer wire without a guest
  guessing. The guest sends binary only when `binaryDraw === true` **and**
  `wireVersion` is one it can encode; otherwise JSON.

**Guest algorithm (spec for the next phase):**

1. On first need to draw (or once at startup), the guest `await`s
   `host_call("host:canvas", "getInfo", {})` **exactly once** and caches the
   result for the guest's lifetime (the host's capability set is fixed per load —
   no need to re-probe per frame).
2. `useBinary := ok==1 && resp.binaryDraw==true && canEncode(resp.wireVersion)`,
   further gated by the guest's own **WIP flag + default**: during WIP the guest
   default is JSON even when `useBinary` is true; promotion flips that default to
   "prefer binary when `useBinary`."
3. `canvas::draw` then encodes with the binary encoder (→ `host:canvas.draw` with
   a `bytes` payload) or the existing JSON encoder accordingly. **Both** paths hit
   the same `draw` method; the host distinguishes them by payload framing (see
   below). The frame semantics are identical, so a guest that fell back to JSON
   renders the same picture.

**Why `getInfo` and not a host-info bit or `hostModules` string?**

- It is **purely additive on an existing seam** — no new export, no ABI change,
  no change to `createHostModuleDispatch`/`WasmGuestHost`. Registering the method
  is a host change; not registering it *is* the "unsupported" answer, riding the
  seam's existing fail-closed default. That directly satisfies "old hosts keep
  JSON" with zero old-host code.
- It is **guest-agnostic** — the *same* `host_call("host:canvas","getInfo")`
  works for a WASM guest (linear-memory ABI) and a QuickJS guest (shell RPC),
  because it is an ordinary capability call, not a WASM-export probe like
  `rill_abi_version` (which a QuickJS guest has no equivalent of). A host-info
  *bit* riding `rill_abi_version`/exports would be WASM-only and would strand the
  QuickJS route — a non-starter given the platform keeps both guest kinds
  first-class.
- It **carries a version**, so the binary wire can evolve (`wireVersion` 2, …)
  without a second handshake mechanism.

The platform doc floats "`__rill.hostModules` or `getInfo` add a capability bit"
as equivalent options; `getInfo` is the one that is additive on the seam the
guest already calls and works identically for both guest kinds, so it is the
concrete choice here.

### 1.4 How the host tells binary from JSON on the `draw` payload

`host:canvas.draw` must accept both encodings during the co-existence window. The
decoder disambiguates with **zero ambiguity** using the magic:

- A **binary** frame begins with the 4 magic bytes `52 43 4E 56` (`RCNV`). Byte 0
  is `0x52` = ASCII `'R'`.
- A **JSON** `draw` body begins with `{` (`0x7B`) — the object
  `{"canvasId":...}`.

`0x52 != 0x7B`, so the host peeks the first byte: `RCNV` magic → binary decoder;
`{` → the legacy `JSON.parse` path. (The full `u32` magic is still checked by the
binary decoder proper; the first-byte peek is only the cheap fork.) This keeps a
single `draw` method for both encodings — no new method name, no second seam
entry to version.

> Implementation note for the next phase: on the WASM path the payload already
> arrives as raw guest `Vec<u8>` (`host_call` is bytes-in/bytes-out), so binary
> needs no base64 or array-of-numbers detour — it rides the same
> `(ptr,len)` the JSON string uses today. This is the "unify byte transfer to
> linear-memory binary" direction of platform requirement R2.

### 1.5 Failure reporting stays additive too

A binary `draw` that fails to decode returns
`{ ok:false, dropped:<opCount>, reason:<token> }`, where `reason` is one of the
`canvas-wire.json` `reasons` tokens. `dropped` is the pre-existing count field;
`reason` is the platform's recently-added additive canvas-failure field. A JSON
`draw` keeps its existing `{ ok, dropped }` shape (a JSON frame has no binary
reasons). **Frame atomicity holds on both paths**: decode the entire frame into
an op array first, replay only if the whole frame is valid, never a half-frame.

---

## 2. JS / QuickJS-path spec (forward-looking; nothing built now)

### 2.1 Today: canvas is Rust-only

The typed `canvas::DrawList` + `canvas::draw` API lives only in the Rust guest
SDK (`crates/rill-guest/src/lib.rs`). The JS SDK has **no** canvas API. So today a
QuickJS guest never emits canvas ops at all, and this contract has exactly one
producer (Rust) and (soon) one binary consumer (the host TS decoder).

**The contract is nonetheless guest-agnostic by construction.** Nothing in
`canvas-wire.json` is Rust-specific: it is a byte layout keyed by the guest's op
stream, and the handshake in §1 is an ordinary `host:canvas` capability call that
both guest kinds already make. When a JS canvas API is added, it emits *the same
bytes* against *the same schema* — no wire change.

### 2.2 Two forward routes for a JS/QuickJS guest to emit binary

When a JS-facing canvas API lands, a QuickJS guest can reach the binary wire by
**either** route; the wire is identical, so the choice is an implementation
tradeoff, not a contract change:

**Route A — host-side wrapping at the shell channel (preferred; platform-stated
sufficient).** The QuickJS guest keeps emitting the **JSON** op-list to
`host:canvas.draw` exactly as the Rust guest does today. The **host shell** (the
worker/bridge that mediates the QuickJS guest — the shell-RPC boundary that uses
`postMessage` structured-clone + `ArrayBuffer` transfer, per platform R2)
transcodes JSON→binary *once*, on the host side, before handing the frame to the
same binary decoder the WASM path uses. No JS encoder ships in the guest bundle;
the QuickJS guest stays tiny and the binary decoder has a single implementation.
The platform has explicitly said host-side wrapping suffices for the QuickJS
route, so this is the **default plan** — and it means the QuickJS guest needs no
`getInfo` gating at all for correctness (it always speaks JSON; the host decides).

**Route B — a JS encoder port of the Rust oracle (only if a measurement demands
it).** If profiling ever shows the host-side transcode is the QuickJS hot path,
port the Rust encoder to JS/TS as a guest-side module that emits `RCNV` bytes
directly, gated by the *same* `host:canvas.getInfo` handshake (§1.3) the Rust
guest uses. Because the encoder is generated/locked against `canvas-wire.json`
and validated by `canvas-wire.golden.json`, a JS port is a *second implementation
of the same oracle* — the golden vectors are the cross-language conformance
pivot, exactly as op-batch has three codecs (Rust/TS/C++) locked to one golden.
No wire redesign; the JS encoder must produce the golden `hex` byte-for-byte.

### 2.3 Why the wire never needs a redesign for the JS route

- The op set, field order, intern policy and limits are **guest-independent** —
  they describe the Canvas2D op stream, which is the same whoever produces it.
- The capability handshake is an **ordinary `host:canvas` call**, so QuickJS
  reaches it through shell RPC and WASM reaches it through linear-memory ABI, with
  no per-guest wire divergence.
- The golden lock makes any future producer (a JS encoder) prove byte-exact
  equivalence to the Rust oracle before it can ship — so "guest-agnostic" is
  enforced, not merely asserted.

---

## 3. What the next phases own (not this file)

1. **Rust encoder (oracle)** — `crates/rill-guest/src/canvas_encode.rs`, behind a
   Cargo feature (mirror `wip-binary-protocol`), generating constants from the
   already-added `canvas_contract.rs` (see `crates/rill-guest/build.rs`
   `generate_canvas_contract`). Produces `canvas-wire.golden.json`.
2. **TS decoder on the public export surface** — a zero-DOM decoder the platform's
   `site/rill-runtime/src/host-canvas.ts` imports (one-shot **and** iterator
   forms), validating `opCount <= maxOps` before the loop, decoding the whole
   frame into an op array, replaying atomically. Consumes the golden bytes.
3. **`host:canvas.getInfo`** capability + the first-byte `draw` fork (§1.3/§1.4),
   WIP-gated, guest default still JSON.
4. **`canvas-wire.CONFORMANCE.md`** — the run book + PASS ledger, mirroring
   `op-batch-wire.CONFORMANCE.md`.
