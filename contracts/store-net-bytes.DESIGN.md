# store-net-bytes — first-class binary values for the host-capability layer (R2)

Design only. No code is written by this document. Companion to
[`canvas-wire.DESIGN.md`](./canvas-wire.DESIGN.md) (whose §1.4 magic-fork and
"host wraps at the shell channel" language this reuses) and the contract
framework in `src/contract/index.ts`.

Goal (platform requirement R2): a **contract-level "this field is a byte
stream"** so that

- a WASM guest passes a linear-memory `ptr+len` (no per-byte JSON),
- a QuickJS guest passes/receives a `Uint8Array`,
- **both guest kinds are semantically identical** — the host handler always
  sees and returns a `Uint8Array` for a bytes field, whatever the guest is,
- type-generation (`docs/guides/host-module-types.md`) maps a bytes field to
  `Uint8Array`,
- existing JSON capabilities are **byte-for-byte unaffected**.

---

## Part 1 — The current flow (verified against source)

### 1.1 WASM guest → host argument path

1. **Guest builds bytes.** The rill-guest Rust SDK builds a request body and
   hands it to `host_call(module, method, input: Vec<u8>)`
   (`crates/rill-guest/src/lib.rs:312`). Today every wrapper builds a **UTF-8
   JSON string** and calls `.into_bytes()` — e.g. `store::put`
   (`crates/rill-guest/src/lib.rs:339-351`) emits `{"key":…,"text":…}`. There
   is **no binary store method in the Rust guest yet**; the doc comment at
   `lib.rs:328-331` notes that a raw-byte `put`/`get` would ride "as a JSON
   number array" via the generic `host_call` — i.e. the number-array hack is the
   *documented placeholder*, not an implemented path in rill.

2. **ABI call.** `HostCall::poll` (`lib.rs:284-308`) fires the import
   `rill_host_call(mod_ptr,mod_len, method_ptr,method_len, in_ptr,in_len, cb_id)`
   (`lib.rs:32-41`). `in_ptr/in_len` point at the guest's `Vec<u8>` in linear
   memory. **The ABI is already bytes-in/bytes-out** — nothing about it is JSON.

3. **Host reads bytes.** `WasmGuestHost.onHostCall`
   (`src/host/wasm-guest/wasm-guest-host.ts:231-289`) reads module/method via
   `readString`, then reads the input:
   - `readBytes(ip, il)` copies the raw bytes out of guest memory bounds-checked
     (`wasm-guest-host.ts:176-179`).
   - **Framing fork** (`wasm-guest-host.ts:264-276`): if the first 4 bytes are
     `RCNV` (`52 43 4E 56`) the raw `Uint8Array` is handed to the handler as-is
     (the canvas binary carve-out); **otherwise `JSON.parse(TextDecoder.decode(raw))`**.
     So today, everything that is not a canvas frame is parsed as JSON here.

4. **Contract boundary.** The parsed value goes to
   `this.dispatch[moduleId]?.[method]` (`wasm-guest-host.ts:277-281`). The
   dispatch table comes from `createHostModuleDispatch(contract, impl)`
   (`src/contract/index.ts:224-257`). `wrapRpcDispatch`
   (`src/contract/index.ts:418-458`) runs `schema.parseInput(args[0])` **before**
   the impl and `schema.parseOutput(result)` **after** (async-aware). Failures
   throw → fail-closed.

5. **Result back.** `onHostCall` `await`s the handler and calls
   `this.resolve(cb, 1, result)` (`wasm-guest-host.ts:282`). `resolve`
   (`wasm-guest-host.ts:293-313`) does `TextEncoder.encode(JSON.stringify(result))`,
   `allocWrite`s it into guest memory (via the guest's `rill_alloc`), and calls
   the guest export `rill_resolve(cb, ok, ptr, len)`. **The return path is
   JSON-only today** — no binary carve-out on the way back.

6. **Guest receives.** `rt::resolve` (`lib.rs:168-183`) copies the bytes with
   `to_vec()` into a `RESULTS` entry, re-polls the task; `HostCall` completes
   with `(ok, response_bytes)`. Host-written buffers land in the **per-turn 64 KiB
   `WIRE` arena** (`lib.rs:101-104`, `WIRE_SIZE = 64*1024`); an **oversized**
   host write falls back to the global heap (talc) with **no matching dealloc —
   it leaks, bounded per turn** (`lib.rs:142-161`). This is load-bearing for the
   return-path caps below.

### 1.2 QuickJS guest → host argument path (differs — and it matters)

The QuickJS provider is `src/host/sandbox/providers/quickjs-native-wasm-provider.ts`
(QuickJS compiled to WASM under emscripten, **not** a Worker).

- Guest calls `R.hostModules[mid][en](arg)` → `__invokeHostRpc`
  (`quickjs-native-wasm-provider.ts:626-633`), which does
  `__sendToHost('__rill_host_invoke', { id, moduleId, exportName, args: arg })`.
- The shell bridge marshals across the C boundary **as a JSON string**:
  host side does `JSON.parse(data)` (`:465`) and calls `fn(m.args)` (`:490`);
  results go back via `injectJson('__rill_host_result', JSON.stringify(value))`
  (`:433`), errors via `JSON.stringify(message)` (`:442`).

**Critical finding:** the QuickJS shell channel is a **synchronous JSON string
bridge**, *not* `postMessage` structured-clone / `ArrayBuffer` transfer. So a
`Uint8Array` argument on this path would be `JSON.stringify`'d into
`{"0":…,"1":…}` — i.e. the QuickJS route **reproduces the number-array bloat at
rill's own shell boundary**. (The `canvas-wire.DESIGN.md` §2.2 "Route A"
language assumes a structured-clone shell; the *actual* provider in the tree is
the JSON-injection one. The design below handles both realities.)

### 1.3 Where the "number-array in JSON" encoding actually lives

- **Not an implemented rill path.** In rill's Rust guest it is only a *doc
  placeholder* (`lib.rs:328-331`) — there is no `store::put_bytes`.
- **Platform-side for host:store/host:net.** rill does **not** define
  `host:store` or `host:net` anywhere (`grep host:net` over `.ts/.rs` is empty;
  no `defineRillContract` in rill registers them). They are registered by the
  downstream platform's `host-store.ts` / `host-net.ts`. The platform's report
  that "host:store carries a value as a number array in JSON, host:net only
  supports text" describes **platform handler + platform contract** behaviour.
- **rill owns the machinery that makes bytes first-class**: the contract
  framework (`src/contract/index.ts`), the WASM dispatch/return codec
  (`wasm-guest-host.ts`), the QuickJS shell codec (the provider above), the
  rill-guest Rust SDK wrappers, and type-gen.

**rill-side vs platform-side split (summary):**

| Concern | Owner |
|---|---|
| `bytes` field type in the contract DSL + manifest + type-gen | **rill** (`src/contract`) |
| WASM envelope codec (guest→host decode, host→guest encode) | **rill** (`wasm-guest-host.ts`) |
| QuickJS shell bytes codec (Uint8Array ⇄ wire) | **rill** (quickjs provider) |
| rill-guest Rust SDK `store::{put,get}_bytes`, `net` | **rill** (`crates/rill-guest`) |
| JS-guest typed helpers (`putBytes`/`getBytes`) | **rill** (guest SDK) |
| `host-store.ts` / `host-net.ts` handlers that now take/return `Uint8Array` | **platform** |

The invariant rill guarantees: **at the dispatch boundary the handler always
receives a `Uint8Array` for a declared bytes field and may return one**,
regardless of guest kind. That is the entire "both guest kinds semantically
identical" promise; the platform handler is written once against `Uint8Array`.

---

## Part 2 — Design

### A. A `bytes` field type in the contract framework

The contract schema layer today is just opaque `parseInput`/`parseOutput`
functions (`src/contract/index.ts:9-27`); there is no field DSL. Keep it that
way and add **one optional, additive descriptor field** that names which
top-level request/response fields are byte streams. It is metadata — it drives
type-gen, the manifest, and the SDK, **not** the wire codec (the wire is
self-describing, see §B).

```ts
// src/contract/index.ts — additive
export interface BinaryFields {
  /** Top-level request field names whose value is a byte stream (Uint8Array). */
  input?: readonly string[];
  /** Top-level response field names whose value is a byte stream. */
  output?: readonly string[];
}

export interface RpcOptions<Input, Output> {
  timeoutMs?: number;
  schema?: BoundarySchema<Input, Output>;
  binary?: BinaryFields;         // NEW — optional
}

export interface RpcDescriptor<Input = void, Output = void> {
  readonly kind: 'rpc';
  readonly timeoutMs?: number;
  readonly schema?: BoundarySchema<Input, Output>;
  readonly binary?: BinaryFields; // NEW — optional, frozen
  readonly __input?: Input;
  readonly __output?: Output;
}
```

- `rpc<...>()` (`:158-166`) copies `options.binary` into the frozen descriptor.
  Every existing `rpc({...})` call omits `binary` and is **unchanged**.
- **Validation** (`validateDescriptor`, `:393-410`): if `binary` is present,
  assert it is an object whose `input`/`output` (when present) are arrays of the
  `GUEST_EXPORT_NAME_PATTERN`-ish field-name strings. Purely additive.
- **Manifest** (`createCapabilitiesManifest`, `:259-290`): add an optional
  `binaryCapabilities: string[]` listing `moduleId.export` that declare any
  bytes field, so a publish gate can see the binary surface. Additive field;
  existing readers ignore it.
- **`parseInput`/`parseOutput` unchanged in mechanism.** A binary capability's
  `parseInput` now simply validates a real `Uint8Array` for the declared field
  (e.g. `value instanceof Uint8Array`) because rill's codec has already
  reconstructed it before `parseInput` runs (§B step 4). This is the fail-closed
  backstop for the self-describing wire.

**Type-gen mapping** (`docs/guides/host-module-types.md`): the host's
declaration generator maps a field listed in `binary.input`/`binary.output` to
`Uint8Array` in the emitted `declare module 'host:*'`. e.g.

```ts
declare module 'host:store' {
  export function putBytes(key: string, value: Uint8Array): Promise<{ version: number }>
  export function getBytes(key: string): Promise<{ value: Uint8Array; version: number } | null>
}
```

rill only fixes the *rule* ("a `binary` field → `Uint8Array`"); the platform's
generator emits it, exactly as the guide already frames type-gen as
host-generated.

### B. The "JSON control plane + binary data plane" envelope

One self-describing wire framing, used **in both directions** on the WASM
boundary. The request/response stays JSON (fields, options); byte-stream fields
are **replaced by a sentinel** referencing an index into an attached binary
segment list (multipart-like). The codec is generic and **contract-agnostic** —
`WasmGuestHost` needs no descriptor knowledge (it only holds the dispatch
table today, `wasm-guest-host.ts:58`).

#### B.1 Byte layout (`Vec<u8>` input and response, identical)

All integers **little-endian** (wasm is LE; matches canvas-wire). Magic is a
distinct `u32` from `RCNV`/`RILL`:

```
offset  size      field
0       4         magic   = 'R' 'B' 'S' '1'  = 52 42 53 31   ("Rill Binary Segments, v1")
4       4         jsonLen : u32
8       jsonLen   json    : UTF-8 control plane (see sentinel below)
8+L     4         segCount: u32          (L = jsonLen)
then, segCount times, tightly packed:
        4         segLen  : u32
        segLen    seg bytes (raw byte stream; segment index = emission order, 0-based)
```

- **Version rides the 4th magic byte** (`'1'`). A v2 wire is `'RBS2'` — a
  distinct `u32`, so an old decoder rejects it on the magic compare (no separate
  version field, mirrors the canvas "distinct magic" discipline).
- **Sentinel:** inside the JSON, a bytes field's value is the object
  `{"$b": N}` (reserved key `$b`, `N` = 0-based segment index). On decode it is
  replaced by the segment's `Uint8Array`. On encode, each `Uint8Array` in the
  value is hoisted to a new segment and replaced by `{"$b":N}`.
- **Self-describing:** the decoder walks the parsed JSON and replaces every
  `{"$b":N}` it finds; the encoder walks the result and hoists every
  `Uint8Array`. No descriptor needed at the codec layer. `parseInput`/
  `parseOutput` (§A) are the validation backstop against a malformed/hostile
  sentinel (e.g. `N` out of range → decode fails closed before the handler).

#### B.2 Request direction (guest → host), WASM

Guest SDK (§C) emits an `RBS1` envelope instead of a plain JSON body. In
`WasmGuestHost.onHostCall` (`wasm-guest-host.ts:264-276`), add a **third fork**
ahead of the current two, checking the full `u32` magic:

```
raw = readBytes(ip, il)
if magic == RCNV  -> hand raw bytes to handler (existing canvas carve-out)
if magic == RBS1  -> decodeEnvelope(raw) -> { json, segments }
                     input = reviveSentinels(JSON.parse(json), segments)   // {"$b":N} -> Uint8Array
else              -> JSON.parse(...)   (existing path, unchanged)
```

`RBS1` and `RCNV` both start with `0x52 'R'`, so — as canvas already does — the
fork compares all 4 magic bytes, never just byte 0. A plain JSON body begins
with `{` (`0x7B`) and matches no magic → **existing capabilities take the exact
same `JSON.parse` path, byte-for-byte unchanged**.

The revived `input` (now containing real `Uint8Array` fields) flows into the
unchanged dispatch → `parseInput` validates → handler receives `Uint8Array`.

#### B.3 Response direction (host → guest), WASM

`WasmGuestHost.resolve` (`wasm-guest-host.ts:293-313`) is generic. Change it to:

```
{ json, segments } = extractSentinels(result)   // hoist every Uint8Array -> {"$b":N}
if segments.length == 0:
    bytes = TextEncoder.encode(JSON.stringify(result))   // UNCHANGED — plain JSON reply
else:
    bytes = encodeEnvelope(json, segments)               // RBS1 frame
allocWrite(bytes); rill_resolve(cb, ok, ptr, len)
```

- A result with **no** `Uint8Array` produces the **identical** JSON reply as
  today — no behaviour change for existing capabilities.
- A result **with** `Uint8Array` produces an `RBS1` frame; the guest SDK decodes
  it (§C). The guest already accepts arbitrary response bytes (`lib.rs:168-183`),
  so no ABI change.

#### B.4 Caps and fail-closed discipline

Reuse the existing bounds-check posture (`assertInBounds`,
`wasm-guest-host.ts:206-216`; the `ok=0` fail-closed default). New constants
(host and guest, kept in lockstep — a conformance test locks them, like
`MAX_BUFFER_BYTES` in `crates/rill-guest/src/conformance.rs:235`):

| cap | value (phase 1) | rationale |
|---|---|---|
| `MAX_SEGMENTS` | 16 | bounds the segment table |
| `MAX_SEGMENT_BYTES` | 1 MiB | one byte stream |
| `MAX_ENVELOPE_BYTES` | 4 MiB | jsonLen + all segments + framing |
| `MAX_JSON_BYTES` | 256 KiB | the control plane (new explicit cap; there is none today) |

Enforcement:
- **Decode (both sides):** every `u32` length is validated against the remaining
  buffer *before* it is used (reject if `segLen`/`jsonLen`/`segCount` overrun, or
  any cap exceeded) → fail-closed. On the host that means `resolve(cb, 0, {error})`;
  on the guest a `None`/`Err`.
- **Encode (host→guest):** if a result's segments exceed the caps, the host
  resolves `ok=0` with an error rather than emitting an oversized frame.
- **Guest return arena (load-bearing):** the guest's host-written buffer lands in
  the 64 KiB `WIRE` arena; a response envelope **> 64 KiB** takes the talc
  fallback that **leaks, bounded per turn** (`lib.rs:142-161`). Phase 1 therefore
  keeps store/net **response** blobs modest by policy and documents the leak;
  **raising `WIRE_SIZE` or adding a dealloc for the oversized fallback is a
  named phase-4 follow-up** (do not silently ship large `getBytes` on top of a
  leaking arena).

#### B.5 QuickJS path — the same *semantics*, a transport-appropriate wire

The QuickJS shell is a **JSON string bridge** (§1.2), so raw segment bytes
cannot ride structured clone there. rill wraps at the shell channel (the
platform-stated preference), so the **handler still sees `Uint8Array`**:

- **Guest → host:** before `JSON.stringify`, each binary value in `args` is
  staged into wasm linear memory via the native `__rill_stageBinary` helper and
  replaced by `{"$bin": <id>}` (plus `{"$view": "<Kind>"}` for typed-array
  views). On the host side the payload is revived by copying the staged bytes
  out of `HEAPU8` (`qjs_binary_ptr`/`qjs_binary_len`) and freeing the slot
  (`qjs_binary_free`) **before** `fn(m.args)`.
- **Host → guest:** the host stages bytes into wasm memory
  (`_malloc` + `qjs_binary_stage`) and sends `{"$bin": <id>}` in the JSON
  payload; the guest-side codec revives each id to a real `ArrayBuffer`
  (zero-copy adoption via `__rill_takeBinary`) and rewraps the declared view
  kind.
- The staging table is the transport *only inside the JSON string bridge*; each
  id is consumed exactly once and freed on consumption (error paths free in
  `finally`), bounded by the same caps (§B.4). Bytes cross the boundary via
  linear memory rather than any text encoding, so payload size stays ~1× the
  raw bytes.

So: **WASM** carries `RBS1` length-prefixed segments; **QuickJS** carries
`$bin` staging-table references in its JSON bridge; **both** deliver bytes to
the same platform handler. The sentinel key differs (`$b` index vs `$bin`
handle) because the transports differ, but the contract-level meaning ("this
field is bytes") is one thing.

### C. rill-guest SDK binary wrappers

Add a generic envelope helper next to `host_call` (`crates/rill-guest/src/lib.rs`),
`no_std`, no JSON crate (reuse `json_escape`, `lib.rs:1673`):

```rust
/// Encode an RBS1 request: `json_control` already contains {"$b":N} sentinels
/// for each segment, in order. Segments are borrowed guest memory, copied into
/// the frame. Fails closed (None) if any cap is exceeded.
pub fn encode_envelope(json_control: &str, segments: &[&[u8]]) -> Option<Vec<u8>>;

/// Decode an RBS1 response into (json_bytes, segment_slices). None if the magic
/// is absent (caller falls back to treating the body as plain JSON) or a length
/// is malformed / over-cap.
pub fn decode_envelope(bytes: &[u8]) -> Option<(&[u8], Vec<&[u8]>)>;
```

**Store (replaces the number-array placeholder at `lib.rs:328-331`):**

```rust
pub mod store {
    /// host:store.putBytes(key, value) -> {"version":n}
    pub async fn put_bytes(key: &str, value: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        // control plane: {"key":"…","value":{"$b":0}}
        let mut json = String::from("{\"key\":");
        json_escape(&mut json, key);
        json.push_str(",\"value\":{\"$b\":0}}");
        let frame = encode_envelope(&json, &[value])
            .ok_or_else(|| Vec::from(&b"{\"error\":\"value too large\"}"[..]))?;
        let (ok, resp) = host_call("host:store", "putBytes", frame).await;
        if ok == 1 { Ok(resp) } else { Err(resp) }
    }

    /// host:store.getBytes(key) -> Some(value) | None (absent). Request has no
    /// bytes out, so it is a plain JSON body; the RESPONSE is an RBS1 envelope.
    pub async fn get_bytes(key: &str) -> Result<Option<Vec<u8>>, Vec<u8>> {
        let mut json = String::from("{\"key\":");
        json_escape(&mut json, key);
        json.push('}');
        let (ok, resp) = host_call("host:store", "getBytes", json.into_bytes()).await;
        if ok != 1 { return Err(resp); }
        // null (absent) -> None; otherwise decode segment 0 as the value.
        match decode_envelope(&resp) {
            Some((_json, segs)) => Ok(segs.first().map(|s| s.to_vec())),
            None => Ok(None), // "null" body => absent key
        }
    }
}
```

`put_bytes`/`get_bytes` carry raw bytes end-to-end — **no JSON number array
anywhere**. The `Vec<u8>` values with `0x00`/`0xFF` ride untouched (segments are
binary; the control-plane JSON only ever holds the sentinel, never the bytes).

**Net (net-new; there is no `net` module in the guest today):**

```rust
pub mod net {
    pub struct Response { pub status: u16, pub headers: Vec<(String,String)>, pub body: Vec<u8> }

    /// host:net.fetchBytes(url, method, headers, body?) — request body rides as a
    /// bytes segment; response body comes back as a segment. `body: None` sends a
    /// plain JSON control plane with no segment.
    pub async fn fetch_bytes(
        url: &str, method: &str,
        headers: &[(&str,&str)], body: Option<&[u8]>,
    ) -> Result<Response, Vec<u8>>;
    // control plane: {"url":…,"method":…,"headers":[…], "body":{"$b":0}?}
    // response envelope: json {"status":…,"headers":[…],"body":{"$b":0}} + segment[0]
}
```

**JS guest SDK equivalent.** A QuickJS guest reaches `host:store`/`host:net`
through the platform-injected `R.hostModules[...]` stubs
(`quickjs-native-wasm-provider.ts:649-663`); with §B.5 in place the guest passes
a **real `Uint8Array`** and receives one:

```ts
await hostModules['host:store'].putBytes(key, value /* Uint8Array */)      // Promise<{version}>
const got = await hostModules['host:store'].getBytes(key)                  // { value: Uint8Array } | null
```

The optional rill guest SDK sugar (`rill/guest`) would expose typed
`putBytes(key, value: Uint8Array)` / `getBytes(key): Promise<Uint8Array|null>`
thin wrappers over those stubs — no encoding logic in the guest, since the shell
does the `$bin` staging.

### D. Acceptance / property test

1. **Store round-trip, WASM guest (property).** For random `Vec<u8>` values —
   **including** ones containing `0x00` and `0xFF`, an empty value, and a value
   **at `MAX_SEGMENT_BYTES`** — `put_bytes(k, v)` then `get_bytes(k)` returns
   `Some(v_exact)`. Assert the returned bytes equal the input byte-for-byte.
   **Guard:** the test taps the wire (a recording host, cf. `RecordedCall`
   at `lib.rs`) and asserts the request/response frames are `RBS1` envelopes and
   that **no array-of-numbers ever appears** — i.e. the control-plane JSON
   contains only the `{"$b":0}` sentinel and the value bytes appear exactly once,
   in the segment (a `grep` for the value's decimal-byte sequence in the JSON
   fails). Also assert an over-cap value fails closed (`Err`/`None`, no partial
   write).
2. **Store round-trip, QuickJS guest (parity).** The same value through the
   QuickJS shell (§B.5) yields the identical `Uint8Array` at the handler and back
   at the guest; assert the shell used `$b64` (not `JSON.stringify` of a typed
   array). This is the "both guest kinds semantically identical" check.
3. **Net binary body.** `fetch_bytes(url, "POST", headers, Some(&random_bytes))`
   against a recording host:net that echoes the body: assert the handler received
   the exact request-body `Uint8Array` and the guest decoded the exact
   response-body bytes — with `0x00`/`0xFF` present and no number array on either
   leg.
4. **Back-compat guard.** An existing text capability (`store::put`/`getText`)
   still sends a `{`-leading plain-JSON body and receives a plain-JSON reply —
   assert the on-wire bytes are unchanged from a pre-change golden (the RBS1
   fork is never taken for a non-binary call).

---

## Part 3 — Risks to the shared contract boundary, and mitigations

1. **Sentinel collision.** A capability could legitimately send an object with
   key `$b`/`$b64`. *Mitigation:* sentinels are only interpreted **inside an
   `RBS1` frame** (WASM) or by the **binary-declared shell path** (QuickJS);
   plain JSON bodies are never sentinel-walked, and only `binary`-declared
   capabilities emit frames. Existing JSON capabilities are untouched. Document
   `$b`/`$b64` as reserved keys.
2. **QuickJS shell is JSON, not structured-clone.** The `canvas-wire.DESIGN.md`
   "structured clone / ArrayBuffer transfer" assumption does **not** match the
   in-tree provider (`quickjs-native-wasm-provider.ts` uses `injectJson`/`JSON.parse`).
   *Mitigation:* the `$b64` shell codec (§B.5). Flagged so the platform does not
   assume a `Uint8Array` survives the bridge untouched.
3. **Guest 64 KiB return arena leak.** Host→guest envelopes > 64 KiB take the
   leaking talc fallback (`lib.rs:142-161`). *Mitigation:* conservative phase-1
   response caps + a named phase-4 follow-up to raise `WIRE_SIZE` or add a
   dealloc. Do not ship large `getBytes` before that.
4. **Codec must be contract-agnostic.** `WasmGuestHost` holds only the dispatch
   table, not descriptors. *Mitigation:* the self-describing sentinel wire (§B)
   needs no descriptor at the codec layer; `binary` metadata (§A) is only for
   type-gen/manifest/validation. Keeps layering intact.
5. **Caps drift between Rust guest and TS host.** *Mitigation:* single-source the
   caps and lock them with a conformance test, exactly as `MAX_BUFFER_BYTES` is
   locked (`crates/rill-guest/src/conformance.rs:235`).
6. **`binary` must be optional everywhere.** Any non-optional addition to
   `RpcDescriptor`/`RpcOptions` would break every existing `rpc()` call.
   *Mitigation:* `binary?` optional; `rpc()` copies it only when present;
   validation only runs when present.

---

## Part 4 — Phased implementation plan (workflow-ready)

- **Phase 0 — envelope spec + golden.** Add `contracts/store-net-bytes.json`
  (magic `RBS1`, layout §B.1, caps §B.4) + a `.golden.json` of hand-checked
  frames (empty value, `00`/`FF` value, at-cap value, multi-segment). Mirrors the
  canvas-wire single-source + golden-lock discipline. **No runtime code.**
- **Phase 1 — contract `bytes` type (rill).** `binary?` on `RpcOptions`/
  `RpcDescriptor`; validation; manifest `binaryCapabilities`; unit tests. Fully
  additive; existing contract tests must pass unchanged.
- **Phase 2 — WASM codec (rill).** `encode/decodeEnvelope` + sentinel revive/
  extract in `wasm-guest-host.ts` (request fork §B.2, response encode §B.3) with
  caps + fail-closed; Rust-guest `encode_envelope`/`decode_envelope`. Lock caps
  with a conformance test. Golden-driven decode tests.
- **Phase 3 — SDK wrappers (rill).** `store::{put,get}_bytes`, `net::fetch_bytes`
  (replace the `lib.rs:328-331` placeholder); the acceptance/property tests (§D
  1, 3, 4).
- **Phase 4 — QuickJS shell codec + parity (rill).** `$b64` wrap/revive in the
  provider (§B.5); parity test (§D 2). **Plus** the arena follow-up (raise
  `WIRE_SIZE` or add oversized-fallback dealloc) before enabling large responses.
- **Phase 5 — type-gen rule + platform handoff.** Document the
  `binary` → `Uint8Array` mapping in `docs/guides/host-module-types.md`; the
  platform switches `host-store.ts`/`host-net.ts` handlers to `Uint8Array` and
  declares the `binary` fields, retiring the number-array hack.

Phases 1–4 are entirely rill-side and independently testable; Phase 5 is the
platform cut-over that the whole design exists to unblock.
