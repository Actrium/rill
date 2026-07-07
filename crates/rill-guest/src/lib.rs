//! rill-guest — ergonomic Rust SDK for native (non-JS) rill WASM guests.
//!
//! It wraps the linear-memory host:* ABI (see `docs/native-guest.zh.md`) so a
//! guest author writes async code:
//!
//! ```ignore
//! rill_guest::rill_guest_main!(guest_main);
//! async fn guest_main() {
//!     let out = rill_guest::store::put("greeting", "hi").await.unwrap();
//! }
//! ```
//!
//! Under the hood the SDK owns the ABI exports (`rill_alloc` / `rill_resolve` /
//! `rill_init`), a global allocator (talc), and a minimal single-task async executor. A
//! host call is a future: on first poll it issues `rill_host_call` and parks;
//! when the host later calls `rill_resolve(cb, …)` the executor re-polls and the
//! future completes. This is the guest side of the same callback-resolve model
//! the existing QuickJS bridge already uses.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;
use core::alloc::Layout;
use core::future::Future;
use core::pin::Pin;
use core::ptr::addr_of_mut;
use core::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

// ---- ABI: the imports the host provides ----
extern "C" {
    fn rill_host_call(
        mod_ptr: *const u8,
        mod_len: usize,
        method_ptr: *const u8,
        method_len: usize,
        in_ptr: *const u8,
        in_len: usize,
        cb_id: u32,
    );
    // One-way render channel: hand the host an operation batch (UTF-8 JSON).
    fn rill_send_batch(batch_ptr: *const u8, batch_len: usize);
    // One-way diagnostics channel: hand the host a UTF-8 log line
    // (wasm-guest-host.ts wires it to its `onLog` sink).
    fn rill_log(msg_ptr: *const u8, msg_len: usize);
}

/// ABI version this SDK speaks. The generated `rill_abi_version` export hands
/// it to the host, which rejects versions it does not support (fail-closed)
/// and tolerates guests that predate the export. Bump ONLY on a breaking
/// wire/export change; additive changes keep the number.
pub const RILL_ABI_VERSION: u32 = 1;

/// Send a UTF-8 diagnostic message to the host (`env.rill_log` → the host's
/// `onLog` sink). Fire-and-forget: the host may drop or ignore it, so use it
/// for observability, never as a data channel. This is a native guest's ONLY
/// window for "what went wrong" — the panic handler reports through it too.
pub fn log(msg: &str) {
    unsafe { rill_log(msg.as_ptr(), msg.len()) }
}

// ---- Global allocator: talc (memory.grow-backed, growable, real free) ----
//
// The guest's own Rust allocations (Box/Vec/String/…) are served by talc, wired
// as the `#[global_allocator]` inside `rill_guest_main!` so each cdylib guest
// instantiates it. On wasm it is `talc::wasm::WasmDynamicTalc`: a single-threaded
// bump-and-free allocator whose backing memory is claimed on demand via
// `memory.grow` (WebAssembly's `memory_grow`), and — unlike the retired
// `BumpAlloc` — it maintains a real free list, so freed blocks are RECLAIMED
// regardless of order. The heap therefore grows to fit the working set and then
// PLATEAUS under alloc/free churn instead of only ever growing (the R3 fix).
//
// These two symbols are re-exported (hidden) so the macro can name them through
// `$crate` — the downstream guest crate does not depend on talc directly.
#[doc(hidden)]
pub use talc::wasm::{new_wasm_dynamic_allocator, WasmDynamicTalc};

/// Runtime the generated ABI exports call into. Not part of the public API.
pub mod rt {
    use super::*;

    static mut TASK: Option<Pin<alloc::boxed::Box<dyn Future<Output = ()>>>> = None;
    static mut RESULTS: Vec<(u32, u32, Vec<u8>)> = Vec::new();
    static mut NEXT_CB: u32 = 1;
    // poll() runs right after each resolve, so a live future consumes its result
    // immediately; only results for *dropped* futures (a HostCall awaited then
    // dropped — see the note on events handlers) linger here. Cap the backlog so
    // that leak is bounded rather than unbounded.
    const MAX_ORPHAN_RESULTS: usize = 64;

    // ---- wire arena: buffers the HOST writes via rill_alloc ----
    // Invariant (load-bearing): a host-written wire buffer is fully consumed
    // before the host->guest entry that delivers it returns (resolve copies at
    // entry via to_vec; dispatch hands handlers a &[u8] that must not escape the
    // call). So the arena is recycled when the outermost turn closes. Before the
    // arena existed these came straight from the global heap and were never freed
    // — structural heap exhaustion for long-lived guests. Oversized requests still
    // fall back to the global heap (talc); on the RETURN path `resolve` now frees
    // that fallback buffer after copying it out (see FALLBACK_ALLOCS + resolve),
    // closing the large-binary-response leak.
    pub(crate) const WIRE_SIZE: usize = 64 * 1024;
    #[repr(C, align(16))]
    struct WireArena([u8; WIRE_SIZE]);
    static mut WIRE: WireArena = WireArena([0; WIRE_SIZE]);
    static mut WIRE_OFF: usize = 0;
    // Depth of nested host->guest entries. A nested entry (e.g. the host's onLog
    // callback synchronously emitting an event mid-dispatch) must NOT recycle the
    // arena while an outer turn may still be reading its payload.
    static mut TURN_DEPTH: u32 = 0;

    // Outstanding talc-FALLBACK allocations `(ptr, size)` that `alloc` handed out
    // for oversized (> WIRE_SIZE) host-written buffers. `resolve` frees a return's
    // SOURCE buffer by looking it up here — so it frees ONLY buffers the guest
    // itself allocated, exactly once. This is the load-bearing safety invariant:
    // `resolve` is a raw ABI entry whose `ptr` is guest-allocated in the real host
    // (the host always writes via `rill_alloc` first), but a test harness or a
    // misbehaving host could pass a foreign pointer; matching against this table
    // means such a pointer is NEVER wild-freed (a bare "off-arena => free" rule
    // would double-free it). Arena buffers are recycled per turn and never appear
    // here. Bounded by MAX_FALLBACK_TRACKED so a fallback with no matching resolve
    // (e.g. an oversized event payload) cannot grow it without limit.
    static mut FALLBACK_ALLOCS: Vec<(usize, usize)> = Vec::new();
    const MAX_FALLBACK_TRACKED: usize = 64;

    pub(crate) fn begin_wire_turn() {
        unsafe { TURN_DEPTH += 1 };
    }
    pub(crate) fn end_wire_turn() {
        unsafe {
            TURN_DEPTH = TURN_DEPTH.saturating_sub(1);
            if TURN_DEPTH == 0 {
                WIRE_OFF = 0;
            }
        }
    }

    /// Test-only accessor for the wire arena's address range, so unit tests can
    /// assert whether a returned pointer landed inside the arena or fell back to
    /// the global heap.
    #[cfg(test)]
    pub(crate) fn wire_range() -> (usize, usize) {
        let base = addr_of_mut!(WIRE) as usize;
        (base, base + WIRE_SIZE)
    }

    /// Whether `ptr` points inside the WIRE arena (vs the talc-fallback heap).
    /// A fast pre-filter for the return-path dealloc: an arena buffer (the common
    /// case) is recycled per turn and must NEVER be freed, so `resolve` skips the
    /// FALLBACK_ALLOCS lookup for it. Available in every build, unlike the
    /// test-only [`wire_range`].
    pub(crate) fn wire_contains(ptr: *const u8) -> bool {
        let base = addr_of_mut!(WIRE) as usize;
        let p = ptr as usize;
        p >= base && p < base + WIRE_SIZE
    }

    /// Number of still-tracked talc-fallback allocations. A deterministic,
    /// noise-free no-leak signal for tests: after every fallback has been
    /// resolved (copied out + freed), this is 0 regardless of what other
    /// concurrently-running tests allocate on the shared global heap.
    #[cfg(test)]
    pub(crate) fn fallback_count() -> usize {
        unsafe { (*addr_of_mut!(FALLBACK_ALLOCS)).len() }
    }

    /// Free the talc-fallback buffer at `ptr` IFF `alloc` handed it out (it is in
    /// FALLBACK_ALLOCS), using the tracked size. A no-op for an arena pointer or
    /// any pointer the guest did not allocate — so it can never wild-free a
    /// foreign buffer. Called by `resolve` after the source has been copied out.
    ///
    /// # Safety
    /// If `ptr` is tracked, it must still be live (not already freed) — upheld
    /// because a fallback ptr is recorded once by `alloc` and removed on the first
    /// matching `resolve`.
    unsafe fn free_fallback_source(ptr: *const u8) {
        if wire_contains(ptr) {
            return; // arena buffer: recycled per turn, never freed here
        }
        let p = ptr as usize;
        if let Some(idx) = FALLBACK_ALLOCS.iter().position(|&(fp, _)| fp == p) {
            let (_, size) = FALLBACK_ALLOCS.remove(idx);
            alloc::alloc::dealloc(ptr as *mut u8, Layout::from_size_align_unchecked(size, 1));
        }
    }

    /// `rill_init` body: box the guest's async entry and drive it once.
    pub fn init(future: impl Future<Output = ()> + 'static) {
        begin_wire_turn();
        unsafe {
            TASK = Some(alloc::boxed::Box::pin(future));
            poll();
        }
        end_wire_turn();
    }

    /// `rill_alloc` body: hand the host a buffer from the guest heap.
    ///
    /// Host-written wire buffers come from the per-turn WIRE arena (recycled at
    /// each outermost turn boundary); an oversized request falls back to the
    /// global heap (talc) and is recorded in FALLBACK_ALLOCS so the return path
    /// (`resolve`) can free it after copying it out. A fallback with no matching
    /// resolve (e.g. an oversized event payload) still relies on the per-turn
    /// recycle for its arena-side reads and leaks the buffer bounded per turn.
    pub fn alloc(size: usize) -> *mut u8 {
        unsafe {
            let need = size.max(1);
            if let Some(end) = WIRE_OFF.checked_add(need) {
                if end <= WIRE_SIZE {
                    let p = (addr_of_mut!(WIRE) as *mut u8).add(WIRE_OFF);
                    WIRE_OFF = end;
                    return p;
                }
            }
            // Oversized wire payload: global heap (talc). Record it so a matching
            // `resolve` can free it (the return-path leak fix). Bound the table:
            // if a fallback never gets a matching resolve, dropping the oldest
            // record only forgets our ability to free that one buffer later (it
            // leaks, exactly as before this fix) — it never frees anything early.
            let p = alloc::alloc::alloc(Layout::from_size_align_unchecked(need, 1));
            if !p.is_null() {
                if FALLBACK_ALLOCS.len() >= MAX_FALLBACK_TRACKED {
                    FALLBACK_ALLOCS.remove(0);
                }
                FALLBACK_ALLOCS.push((p as usize, need));
            }
            p
        }
    }

    /// `rill_resolve` body: stash the result for `cb` and re-drive the task.
    ///
    /// # Safety
    /// `ptr`/`len` must describe a valid buffer in guest memory — upheld by the
    /// host, which wrote the result there via `rill_alloc` before calling.
    pub unsafe fn resolve(cb: u32, ok: u32, ptr: *const u8, len: usize) {
        begin_wire_turn();
        let bytes = if !ptr.is_null() && len > 0 {
            let copied = core::slice::from_raw_parts(ptr, len).to_vec();
            // RETURN-PATH LEAK FIX. The host wrote this response via `rill_alloc`.
            // A buffer that fit the WIRE arena is recycled by the per-turn reset
            // and MUST NOT be freed here. But an OVERSIZED (> WIRE_SIZE) return
            // took the talc fallback in `alloc`, which has no other owner and,
            // before this, no matching dealloc — so every large binary response
            // leaked, undoing the R3 bounded heap. Now that the source is copied
            // out (`to_vec` above), free it IFF it is a fallback buffer WE
            // allocated (tracked in FALLBACK_ALLOCS) — never a foreign pointer.
            // The WIRE per-turn semantics and the R3 invariants are untouched;
            // only the off-arena fallback the guest itself owns is reclaimed.
            free_fallback_source(ptr);
            copied
        } else {
            Vec::new()
        };
        RESULTS.push((cb, ok, bytes));
        poll();
        // Drop the oldest orphaned result(s) if the backlog grew past the cap
        // (results whose future was dropped and will never take_result them).
        while RESULTS.len() > MAX_ORPHAN_RESULTS {
            RESULTS.remove(0);
        }
        end_wire_turn();
    }

    /// Re-drive the guest task from OUTSIDE a host-call resolution.
    ///
    /// The executor is normally re-polled only by [`resolve`] (a host call
    /// completing). An event handler ([`crate::events`]) is synchronous and does
    /// NOT re-poll the task, so a future that parks waiting on an event (e.g. a
    /// canvas frame tick) would never advance. A handler calls `wake()` after
    /// updating guest state to poll the task once and let such a future proceed.
    ///
    /// Safe re-entrancy: `wake()` is only ever called from `rill_on_event`, which
    /// the host invokes while the guest is PARKED (never mid-poll, never nested in
    /// a `resolve`) — same precondition `resolve`'s own `poll()` relies on. So it
    /// cannot alias `&mut TASK`. Do NOT call it from inside a running poll.
    pub fn wake() {
        poll();
    }

    /// Report a panic's location + message to the host via `rill_log`, then
    /// return so the caller (the generated panic handler) can trap.
    ///
    /// Uses a fixed-size STACK buffer with a truncating `core::fmt::Write` —
    /// no allocation, because the panic may itself be an allocation failure
    /// (heap exhausted — `memory.grow` refused). Truncation lands on a UTF-8 char boundary so the
    /// host's text decoding never sees a split code point.
    pub fn panic_log(info: &core::panic::PanicInfo) {
        struct StackBuf {
            buf: [u8; 512],
            len: usize,
        }
        impl core::fmt::Write for StackBuf {
            fn write_str(&mut self, s: &str) -> core::fmt::Result {
                let space = self.buf.len() - self.len;
                let mut n = s.len().min(space);
                while n > 0 && !s.is_char_boundary(n) {
                    n -= 1;
                }
                self.buf[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
                self.len += n;
                Ok(()) // swallow overflow: a truncated report beats none
            }
        }
        let mut out = StackBuf {
            buf: [0; 512],
            len: 0,
        };
        // PanicInfo's Display includes the source location and the message.
        let _ = core::fmt::write(&mut out, format_args!("guest panic: {info}"));
        unsafe { super::rill_log(out.buf.as_ptr(), out.len) };
    }

    pub(crate) fn next_cb() -> u32 {
        unsafe {
            let c = NEXT_CB;
            NEXT_CB += 1;
            c
        }
    }

    pub(crate) fn take_result(cb: u32) -> Option<(u32, Vec<u8>)> {
        unsafe {
            let idx = RESULTS.iter().position(|r| r.0 == cb)?;
            let (_, ok, bytes) = RESULTS.remove(idx);
            Some((ok, bytes))
        }
    }

    fn poll() {
        unsafe {
            if let Some(task) = TASK.as_mut() {
                let waker = noop_waker();
                let mut cx = Context::from_waker(&waker);
                if task.as_mut().poll(&mut cx).is_ready() {
                    TASK = None;
                }
            }
        }
    }

    // We re-poll manually from resolve(), so the waker does nothing.
    fn noop_waker() -> Waker {
        const VT: RawWakerVTable = RawWakerVTable::new(
            |_| RawWaker::new(core::ptr::null(), &VT),
            |_| {},
            |_| {},
            |_| {},
        );
        unsafe { Waker::from_raw(RawWaker::new(core::ptr::null(), &VT)) }
    }
}

/// A pending host:* call. First poll issues `rill_host_call`; completes when the
/// host resolves the matching `cb_id`. Output is `(ok, response_bytes)`.
pub struct HostCall {
    cb: u32,
    sent: bool,
    module: &'static str,
    method: &'static str,
    input: Vec<u8>,
}

impl Future for HostCall {
    type Output = (u32, Vec<u8>);
    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if !this.sent {
            this.sent = true;
            unsafe {
                rill_host_call(
                    this.module.as_ptr(),
                    this.module.len(),
                    this.method.as_ptr(),
                    this.method.len(),
                    this.input.as_ptr(),
                    this.input.len(),
                    this.cb,
                );
            }
            return Poll::Pending;
        }
        match rt::take_result(this.cb) {
            Some(result) => Poll::Ready(result),
            None => Poll::Pending,
        }
    }
}

/// Issue an arbitrary host:* call. `input` is the request body (bytes in guest
/// memory the host reads synchronously).
pub fn host_call(module: &'static str, method: &'static str, input: Vec<u8>) -> HostCall {
    HostCall {
        cb: rt::next_cb(),
        sent: false,
        module,
        method,
        input,
    }
}

/// Typed wrapper over the `host:store` capability — the platform's per-user,
/// per-app E2EE key/value store. The wire mirrors the platform's `host-store.ts`
/// contract EXACTLY (method names + payload field names), so a native guest
/// built on this SDK talks to the module the platform actually registers.
///
/// A native guest works with UTF-8 strings, so this wraps the contract's text
/// convenience methods (`putText` / `getText` — the HOST does the byte
/// encoding) plus `delete`. The raw-byte `put` / `get` (`value` rides as a
/// JSON number array) and `update` / `list` remain reachable via
/// [`crate::host_call`] until typed wrappers land.
pub mod store {
    use crate::json_escape;
    use crate::store_net_encode::{decode_reply, encode_envelope, Value};
    use alloc::string::String;
    use alloc::vec::Vec;

    /// `host:store.putText(key, text)` -> the response body on success
    /// (`{"version":n}`).
    pub async fn put(key: &str, text: &str) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"key\":");
        json_escape(&mut body, key);
        body.push_str(",\"text\":");
        json_escape(&mut body, text);
        body.push('}');
        let (ok, bytes) = super::host_call("host:store", "putText", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// `host:store.getText(key)` -> the response body on success
    /// (`{"text":"…","version":n}`, or `null` for an absent key).
    pub async fn get(key: &str) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"key\":");
        json_escape(&mut body, key);
        body.push('}');
        let (ok, bytes) = super::host_call("host:store", "getText", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// `host:store.delete(key)` -> the response body on success
    /// (`{"deleted":bool}`).
    pub async fn del(key: &str) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"key\":");
        json_escape(&mut body, key);
        body.push('}');
        let (ok, bytes) = super::host_call("host:store", "delete", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// `host:store.putBytes(key, value)` — store a RAW byte value under `key`.
    /// The value rides the RBS1 envelope as a length-prefixed binary SEGMENT;
    /// the control plane is `{"key":"…","value":{"$b":0}}` — the value bytes
    /// (incl. `0x00`/`0xFF`) NEVER appear as a JSON number-array (the R2 goal).
    /// Returns the host's ack body on success (`{"version":n}`), or a small
    /// `{"error":"…"}` body if the value breaches a codec cap (fail-closed, no
    /// partial write) or the host fails the call.
    pub async fn put_bytes(key: &str, value: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
        let mut json = String::from("{\"key\":");
        json_escape(&mut json, key);
        json.push_str(",\"value\":{\"$b\":0}}");
        // Hoist the value to segment 0; an over-cap value fails closed here
        // before any host call is issued (nothing partial crosses the seam).
        let frame = encode_envelope(&json, &[value]).map_err(crate::codec_error)?;
        let (ok, resp) = super::host_call("host:store", "putBytes", frame).await;
        if ok == 1 {
            Ok(resp)
        } else {
            Err(resp)
        }
    }

    /// `host:store.getBytes(key)` — read a raw byte value. The REQUEST carries no
    /// bytes, so it is a plain-JSON body (`{"key":"…"}`); the RESPONSE is an RBS1
    /// envelope `{"value":{"$b":0},"version":n}` whose segment 0 is the value.
    /// Returns `Ok(Some(value))` when present, `Ok(None)` for an absent key (the
    /// host replies with a bare `null`), or `Err(body)` on failure.
    pub async fn get_bytes(key: &str) -> Result<Option<Vec<u8>>, Vec<u8>> {
        let mut json = String::from("{\"key\":");
        json_escape(&mut json, key);
        json.push('}');
        let (ok, resp) = super::host_call("host:store", "getBytes", json.into_bytes()).await;
        if ok != 1 {
            return Err(resp);
        }
        match decode_reply(&resp).map_err(crate::codec_error)? {
            // Absent key: the host replies with a plain-JSON `null`.
            Value::Null => Ok(None),
            // Present: pull the revived byte field out of the reply object.
            Value::Obj(entries) => {
                for (k, v) in entries {
                    if k == "value" {
                        return match v {
                            Value::Bytes(b) => Ok(Some(b)),
                            _ => Err(Vec::from(
                                &b"{\"error\":\"getBytes: value is not a byte stream\"}"[..],
                            )),
                        };
                    }
                }
                Err(Vec::from(
                    &b"{\"error\":\"getBytes: reply missing value field\"}"[..],
                ))
            }
            _ => Err(Vec::from(
                &b"{\"error\":\"getBytes: unexpected reply shape\"}"[..],
            )),
        }
    }
}

/// Typed wrapper over the `host:net` capability — a host-mediated HTTP fetch for
/// native guests, carrying a BINARY request/response body over the RBS1 envelope.
///
/// The request body (when present) rides as a length-prefixed binary SEGMENT and
/// the response body comes back the same way — so arbitrary bytes (incl.
/// `0x00`/`0xFF`) cross the seam untouched, NEVER as a JSON number-array. The
/// control plane holds only the url/method/headers and a `{"$b":0}` sentinel for
/// the body. A `body: None` request has no segment, so it is a plain-JSON control
/// plane (byte-for-byte the back-compat shape).
pub mod net {
    use crate::json_escape;
    use crate::store_net_encode::{decode_reply, encode_envelope, Value};
    use alloc::string::String;
    use alloc::vec::Vec;

    /// A decoded `host:net.fetchBytes` response: the HTTP status, the response
    /// headers, and the raw response body (revived from the envelope's segment,
    /// empty when the response carried none).
    #[derive(Debug, Clone, PartialEq, Eq, Default)]
    pub struct Response {
        /// HTTP status code (e.g. 200).
        pub status: u16,
        /// Response headers as `(name, value)` pairs, in the host's order.
        pub headers: Vec<(String, String)>,
        /// The raw response body bytes (empty if the response had no body).
        pub body: Vec<u8>,
    }

    /// `host:net.fetchBytes(url, method, headers, body?)` — issue an HTTP request
    /// whose body (when `Some`) rides as a binary segment, and decode the binary
    /// response body from the reply envelope.
    ///
    /// Control plane: `{"url":…,"method":…,"headers":[[k,v],…]}` plus
    /// `,"body":{"$b":0}` when a body is supplied. Returns the decoded
    /// [`Response`] on success, or a small `{"error":"…"}` body on a codec cap
    /// breach (fail-closed) or a host failure.
    pub async fn fetch_bytes(
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Response, Vec<u8>> {
        let mut json = String::from("{\"url\":");
        json_escape(&mut json, url);
        json.push_str(",\"method\":");
        json_escape(&mut json, method);
        json.push_str(",\"headers\":[");
        for (i, (name, val)) in headers.iter().enumerate() {
            if i > 0 {
                json.push(',');
            }
            json.push('[');
            json_escape(&mut json, name);
            json.push(',');
            json_escape(&mut json, val);
            json.push(']');
        }
        json.push(']');

        // Body rides segment 0 when present; otherwise the request stays a plain
        // JSON control plane (no segment => back-compat shape).
        let frame = match body {
            Some(bytes) => {
                json.push_str(",\"body\":{\"$b\":0}}");
                encode_envelope(&json, &[bytes]).map_err(crate::codec_error)?
            }
            None => {
                json.push('}');
                json.into_bytes()
            }
        };

        let (ok, resp) = crate::host_call("host:net", "fetchBytes", frame).await;
        if ok != 1 {
            return Err(resp);
        }
        parse_response(&resp)
    }

    /// Decode a `fetchBytes` reply (RBS1 envelope, or plain JSON when the response
    /// had no body) into a [`Response`]. Fail-closed: a malformed frame or a reply
    /// that is not the expected object surfaces as an `Err(body)`.
    fn parse_response(resp: &[u8]) -> Result<Response, Vec<u8>> {
        let entries = match decode_reply(resp).map_err(crate::codec_error)? {
            Value::Obj(entries) => entries,
            _ => {
                return Err(Vec::from(
                    &b"{\"error\":\"fetchBytes: reply is not an object\"}"[..],
                ))
            }
        };
        let mut out = Response::default();
        for (key, value) in entries {
            match (key.as_str(), value) {
                ("status", Value::Num(n)) => out.status = n as u16,
                ("headers", Value::Arr(items)) => {
                    for item in items {
                        if let Value::Arr(pair) = item {
                            if let [Value::Str(name), Value::Str(val)] = &pair[..] {
                                out.headers.push((name.clone(), val.clone()));
                            }
                        }
                    }
                }
                ("body", Value::Bytes(b)) => out.body = b,
                _ => {}
            }
        }
        Ok(out)
    }
}

/// Typed wrapper over the `host:canvas` capability — a host-mediated 2D drawing
/// surface for native guests.
///
/// Two paths, both landing on the same `<Canvas>` sealed component:
///  - `DrawList` + `draw(id, &list).await`: build a Canvas2D display list the
///    host validates op-by-op and REPLAYS onto a real 2D context (stage ①).
///  - `Surface` + `present(id, &surface).await`: software-render RGBA8 into the
///    guest's own linear memory; the host reads it back (bounds-checked) and
///    blits (stage ②; the host wiring for `present` may not exist yet).
///
/// The wire shape (op names + arg field names) follows the `host:canvas` seam of
/// `contracts/graphics-seams.json` — the repo's single authoritative source, which
/// downstream host validators (their `host-canvas.ts` `OP_SPECS`) must mirror; the
/// conformance tests in `src/conformance.rs` lock this SDK to it. Styles are color
/// STRINGS only (no gradient/pattern object → no image/URL reference), and there
/// is deliberately NO readback — the seal's isolation lives in the ABSENCE of
/// those, not in a runtime check.
pub mod canvas {
    use crate::json_escape;
    use alloc::format;
    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;

    /// A 2D display list. Chain draw ops, then `canvas::draw(id, &list).await`.
    /// Serializes to exactly the `host:canvas.draw` op-list the host accepts;
    /// unknown/invalid ops would be dropped host-side, so build valid ops here.
    #[derive(Default)]
    pub struct DrawList {
        ops: String,
        count: usize,
        // Latched when an op was fed a non-finite number. NaN/inf format as
        // `NaN`/`inf` — not legal JSON — so ONE bad op would make the whole
        // batch unparseable host-side and the entire frame would be dropped
        // with no reason. Instead: skip the op, latch, and fail loud in draw().
        non_finite: bool,
        // Parallel typed op log for the WORK-IN-PROGRESS binary canvas wire
        // (`canvas_encode`). Recorded only for ops that actually pass the
        // `finite` guard and are pushed to `ops`, so the binary and JSON emit
        // paths carry the IDENTICAL op sequence. Gated OFF by default: the live
        // `draw` path never touches it and the shipped guest never builds it.
        #[cfg(feature = "wip-binary-protocol")]
        bin_ops: alloc::vec::Vec<crate::canvas_encode::CanvasOp>,
    }

    impl DrawList {
        /// A fresh, empty display list.
        pub fn new() -> Self {
            Self::default()
        }

        fn push(&mut self, op: String) {
            if !self.ops.is_empty() {
                self.ops.push(',');
            }
            self.ops.push_str(&op);
            self.count += 1;
        }

        /// Record the typed op for the WIP binary wire (no-op when the feature
        /// is off). Called right after `push`, so it mirrors the JSON path's op
        /// sequence exactly (only finite, actually-emitted ops are recorded).
        #[cfg(feature = "wip-binary-protocol")]
        #[inline]
        fn rec(&mut self, op: crate::canvas_encode::CanvasOp) {
            self.bin_ops.push(op);
        }

        // Guard for every float-taking op: non-finite input skips the op and
        // latches the list invalid (see `non_finite`).
        fn finite(&mut self, vals: &[f64]) -> bool {
            if vals.iter().all(|v| v.is_finite()) {
                true
            } else {
                self.non_finite = true;
                false
            }
        }

        /// Whether every op so far had finite numeric arguments. A `false`
        /// list is rejected by [`draw`] before it reaches the host.
        pub fn is_valid(&self) -> bool {
            !self.non_finite
        }

        /// Number of ops queued.
        pub fn len(&self) -> usize {
            self.count
        }
        /// Whether the list has no ops.
        pub fn is_empty(&self) -> bool {
            self.count == 0
        }

        // ---- path construction ----
        /// `beginPath()`.
        pub fn begin_path(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"beginPath\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::BeginPath);
            self
        }
        /// `closePath()`.
        pub fn close_path(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"closePath\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::ClosePath);
            self
        }
        /// `moveTo(x, y)`.
        pub fn move_to(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"moveTo\",\"x\":{x},\"y\":{y}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::MoveTo { x, y });
            self
        }
        /// `lineTo(x, y)`.
        pub fn line_to(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"lineTo\",\"x\":{x},\"y\":{y}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::LineTo { x, y });
            self
        }
        /// `rect(x, y, w, h)` (adds a rectangle sub-path).
        pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            if !self.finite(&[x, y, w, h]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"rect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Rect { x, y, w, h });
            self
        }
        /// `arc(x, y, r, start, end)` counter-clockwise=false.
        pub fn arc(&mut self, x: f64, y: f64, r: f64, start: f64, end: f64) -> &mut Self {
            if !self.finite(&[x, y, r, start, end]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"arc\",\"x\":{x},\"y\":{y},\"r\":{r},\"start\":{start},\"end\":{end},\"ccw\":false}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Arc {
                x,
                y,
                r,
                start,
                end,
                ccw: false,
            });
            self
        }
        /// `fill()` the current path.
        pub fn fill(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"fill\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Fill);
            self
        }
        /// `stroke()` the current path.
        pub fn stroke(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"stroke\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Stroke);
            self
        }

        // ---- rectangles ----
        /// `fillRect(x, y, w, h)`.
        pub fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            if !self.finite(&[x, y, w, h]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"fillRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::FillRect { x, y, w, h });
            self
        }
        /// `strokeRect(x, y, w, h)`.
        pub fn stroke_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            if !self.finite(&[x, y, w, h]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"strokeRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::StrokeRect { x, y, w, h });
            self
        }
        /// `clearRect(x, y, w, h)`.
        pub fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            if !self.finite(&[x, y, w, h]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"clearRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::ClearRect { x, y, w, h });
            self
        }

        // ---- styles (color is a CSS string only — never a gradient/pattern) ----
        /// `fillStyle = color` (CSS color string).
        pub fn set_fill_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setFillStyle\",\"color\":");
            json_escape(&mut s, color);
            s.push('}');
            self.push(s);
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::SetFillStyle {
                color: alloc::string::String::from(color),
            });
            self
        }
        /// `strokeStyle = color` (CSS color string).
        pub fn set_stroke_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setStrokeStyle\",\"color\":");
            json_escape(&mut s, color);
            s.push('}');
            self.push(s);
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::SetStrokeStyle {
                color: alloc::string::String::from(color),
            });
            self
        }
        /// `lineWidth = w`.
        pub fn set_line_width(&mut self, w: f64) -> &mut Self {
            if !self.finite(&[w]) {
                return self;
            }
            self.push(format!("{{\"op\":\"setLineWidth\",\"w\":{w}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::SetLineWidth { w });
            self
        }

        // ---- text ----
        /// `fillText(text, x, y)`.
        pub fn fill_text(&mut self, text: &str, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            let mut s = format!("{{\"op\":\"fillText\",\"x\":{x},\"y\":{y},\"text\":");
            json_escape(&mut s, text);
            s.push('}');
            self.push(s);
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::FillText {
                x,
                y,
                text: alloc::string::String::from(text),
            });
            self
        }

        // ---- transform stack ----
        /// `save()` the drawing state.
        pub fn save(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"save\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Save);
            self
        }
        /// `restore()` the drawing state.
        pub fn restore(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"restore\"}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Restore);
            self
        }
        /// `translate(x, y)`.
        pub fn translate(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"translate\",\"x\":{x},\"y\":{y}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Translate { x, y });
            self
        }
        /// `scale(x, y)`.
        pub fn scale(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"scale\",\"x\":{x},\"y\":{y}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Scale { x, y });
            self
        }
        /// `rotate(angle)` (radians).
        pub fn rotate(&mut self, angle: f64) -> &mut Self {
            if !self.finite(&[angle]) {
                return self;
            }
            self.push(format!("{{\"op\":\"rotate\",\"angle\":{angle}}}"));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::Rotate { angle });
            self
        }
        /// `setTransform(a, b, c, d, e, f)`.
        pub fn set_transform(
            &mut self,
            a: f64,
            b: f64,
            c: f64,
            d: f64,
            e: f64,
            f: f64,
        ) -> &mut Self {
            if !self.finite(&[a, b, c, d, e, f]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"setTransform\",\"a\":{a},\"b\":{b},\"c\":{c},\"d\":{d},\"e\":{e},\"f\":{f}}}"
            ));
            #[cfg(feature = "wip-binary-protocol")]
            self.rec(crate::canvas_encode::CanvasOp::SetTransform { a, b, c, d, e, f });
            self
        }

        /// Encode this frame's ops to the binary CANVAS wire
        /// (`contracts/canvas-wire.json`) targeting `<Canvas>` `canvas_id` with
        /// diagnostic `frame_id`. WORK IN PROGRESS: the encoded bytes are an
        /// alternative to the JSON `draw` payload, but the live `draw` path does
        /// NOT use them yet — the capability-driven binary-vs-JSON selection is a
        /// later phase. Fails closed on the same caps the encoder enforces.
        #[cfg(feature = "wip-binary-protocol")]
        pub fn encode_binary(
            &self,
            canvas_id: &str,
            frame_id: u32,
        ) -> Result<Vec<u8>, crate::canvas_encode::EncodeError> {
            crate::canvas_encode::Encoder::new().encode_frame(canvas_id, frame_id, &self.bin_ops)
        }
    }

    // ---- capability handshake (WIP binary canvas wire) ----
    //
    // Cache for the one-shot `host:canvas.getInfo` probe (see
    // `host_supports_binary`). `None` = not probed yet; `Some(b)` = the host's
    // answer, fixed for the guest's lifetime (a host's capability set is fixed
    // per load, so the probe never repeats). Single-task guest, no threads.
    #[cfg(feature = "wip-binary-protocol")]
    static mut BINARY_SUPPORTED: Option<bool> = None;
    // Monotonic diagnostic frame counter stamped into each binary frame header.
    // Only the frame BYTES carry it; the replayed op array does not, so it never
    // affects rendering — it is purely for host-side tracing.
    #[cfg(feature = "wip-binary-protocol")]
    static mut FRAME_ID: u32 = 0;

    #[cfg(feature = "wip-binary-protocol")]
    fn next_frame_id() -> u32 {
        unsafe {
            let f = FRAME_ID;
            FRAME_ID = FRAME_ID.wrapping_add(1);
            f
        }
    }

    /// Naive substring search (`no_std`, no regex/JSON parser available). The
    /// host's `getInfo` response is compact machine JSON (`JSON.stringify`, no
    /// insignificant whitespace), so an exact-substring probe is deterministic.
    #[cfg(feature = "wip-binary-protocol")]
    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        if needle.is_empty() {
            return true;
        }
        hay.windows(needle.len()).any(|w| w == needle)
    }

    /// Capability handshake (`canvas-wire.DESIGN.md` §1.3): probe
    /// `host:canvas.getInfo` EXACTLY ONCE and cache the answer. The host is
    /// binary-capable only if it (a) resolves `ok=1` — an old host that never
    /// registered `getInfo` fails closed with `ok=0` — and advertises both
    /// (b) `binaryDraw:true` and (c) a `wireVersion` this encoder can produce.
    /// Any non-affirmative answer ⇒ JSON, so a new guest degrades gracefully on
    /// an old host with zero old-host code (no flag-day).
    #[cfg(feature = "wip-binary-protocol")]
    async fn host_supports_binary() -> bool {
        unsafe {
            if let Some(v) = BINARY_SUPPORTED {
                return v;
            }
        }
        let (ok, resp) = crate::host_call("host:canvas", "getInfo", Vec::from(&b"{}"[..])).await;
        let mut supported = false;
        if ok == 1 {
            let has_flag = contains(&resp, b"\"binaryDraw\":true");
            let ver_needle = format!("\"wireVersion\":{}", crate::canvas_encode::WIRE_VERSION);
            let has_version = contains(&resp, ver_needle.as_bytes());
            supported = has_flag && has_version;
        }
        unsafe {
            BINARY_SUPPORTED = Some(supported);
        }
        supported
    }

    /// `host:canvas.draw` — replay `list` onto the `<Canvas>` named `canvas_id`.
    /// Returns `Ok(response)` (`{"ok":true,"dropped":n}`) or `Err(response)` if
    /// the host fails closed (e.g. unknown/unmounted canvas id).
    ///
    /// Encoding selection (`canvas-wire.DESIGN.md` §1): when the crate is built
    /// with `wip-binary-protocol` AND the host advertised `binaryDraw` for a
    /// `wireVersion` this encoder produces, the frame goes out as the binary
    /// `RCNV` wire; otherwise (default shipped guest, old host, over-cap frame)
    /// it goes out as the legacy JSON op-list. Both paths hit the SAME `draw`
    /// method and render the identical picture — the host forks on the payload's
    /// first byte (`R` binary vs `{` JSON).
    pub async fn draw(canvas_id: &str, list: &DrawList) -> Result<Vec<u8>, Vec<u8>> {
        if !list.is_valid() {
            // Fail loud guest-side: a non-finite op would have produced invalid
            // JSON and the host would drop the whole batch with no reason.
            return Err(Vec::from(
                &b"{\"error\":\"non-finite number in draw list\"}"[..],
            ));
        }

        // WIP binary path: only taken when the feature is compiled in AND the
        // host advertised support. A failed encode (over-cap frame) falls
        // through to JSON so the guest never drops a frame just because binary
        // could not represent it.
        #[cfg(feature = "wip-binary-protocol")]
        {
            if host_supports_binary().await {
                if let Ok(frame) = list.encode_binary(canvas_id, next_frame_id()) {
                    let (ok, bytes) = crate::host_call("host:canvas", "draw", frame).await;
                    return if ok == 1 { Ok(bytes) } else { Err(bytes) };
                }
            }
        }

        // Default / fallback: the legacy JSON op-list (unchanged).
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(",\"ops\":[");
        body.push_str(&list.ops);
        body.push_str("]}");
        let (ok, bytes) = crate::host_call("host:canvas", "draw", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// A linear-memory RGBA8 framebuffer for stage ② `present`. Software-render
    /// into `pixels_mut()`, then `present(id, &surface).await`.
    ///
    /// Straight-alpha (non-premultiplied), row-major, stride = `width * 4` — the
    /// `putImageData` contract the host blit expects. Backed by the guest's global
    /// heap (talc). talc reclaims freed buffers, so a `Surface::new` per frame no
    /// longer leaks for the guest's life; still, prefer allocating a Surface ONCE
    /// and reusing it across frames to avoid per-frame allocation churn.
    ///
    /// Double-buffering: `present(id, &surface).await` resolves only AFTER the host
    /// has finished reading these bytes, so with a single Surface it is already
    /// safe to overwrite for the next frame once the await returns (at most one
    /// frame in flight — the ack is the backpressure). A guest that wants to render
    /// frame N+1 while the host still blits frame N can instead allocate TWO
    /// Surfaces once and alternate them (write A / present B, then swap); allocating
    /// the two buffers once and reusing them still avoids per-frame churn.
    pub struct Surface {
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    }

    impl Surface {
        /// Allocate a `width`×`height` RGBA8 buffer (zeroed = transparent black).
        pub fn new(width: u32, height: u32) -> Self {
            let len = (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(4);
            Self {
                width,
                height,
                pixels: vec![0u8; len],
            }
        }

        /// Logical width in pixels.
        pub fn width(&self) -> u32 {
            self.width
        }
        /// Logical height in pixels.
        pub fn height(&self) -> u32 {
            self.height
        }
        /// The RGBA8 pixels, for software rendering (`[r,g,b,a, r,g,b,a, …]`).
        pub fn pixels_mut(&mut self) -> &mut [u8] {
            &mut self.pixels
        }
        /// Read-only view of the RGBA8 pixels.
        pub fn pixels(&self) -> &[u8] {
            &self.pixels
        }
        /// The linear-memory offset of the pixel buffer — the `ptr` the host
        /// reads (bounds-checked) during `present`.
        pub fn ptr(&self) -> usize {
            self.pixels.as_ptr() as usize
        }
    }

    /// `host:canvas.present` — hand the host `surface`'s pixels to blit onto the
    /// `<Canvas>` named `canvas_id`. The host reads guest memory at `surface.ptr()`
    /// (bounds-checked) and `putImageData`s it; `.await` resolves after the host
    /// is done reading, so the buffer is then safe to overwrite for the next frame
    /// (this return is the backpressure signal — at most one frame in flight).
    ///
    /// The await-per-frame above is the COOPERATIVE guest's own backpressure (one
    /// present in flight). It is not host-enforced: the host additionally BYTE-
    /// BUDGETS present per canvas (a ~64MB blit is costly), so a non-cooperative
    /// guest that skips the discipline is still rate-bounded host-side — it cannot
    /// flood the main thread, its excess presents just fail closed.
    pub async fn present(canvas_id: &str, surface: &Surface) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(&format!(
            ",\"ptr\":{},\"width\":{},\"height\":{},\"format\":\"rgba8\"}}",
            surface.ptr(),
            surface.width,
            surface.height
        ));
        let (ok, bytes) = crate::host_call("host:canvas", "present", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }
}

/// Typed wrapper over the `host:asset` capability — resolve an app-package
/// `assetId` to decoded RGBA in the guest's OWN linear memory (the ④ pixera path).
/// The wire (method + field names) follows the `host:asset` seam of
/// `contracts/graphics-seams.json`, the authoritative source downstream host
/// validators mirror too.
///
/// The host owns the resolution + decode: `assetId` is looked up in the app
/// manifest, gated (same-origin package raster only — never a guest URL, never
/// svg), and the decode is dimension-capped BEFORE the full raster (anti-bomb).
/// The guest never fetches or decodes anything; it only:
///   1. `info(id)` → `(w, h)`,
///   2. allocates a `Surface` of `w×h` (its own memory),
///   3. `blit(id, &mut buffer)` → the host writes the RGBA into that buffer.
///
/// `load(id)` does all three and hands back a ready-to-composite `Surface`.
pub mod asset {
    use crate::canvas::Surface;
    use crate::json_escape;
    use alloc::format;
    use alloc::string::String;

    /// `host:asset.info(id)` → the decoded asset's `(width, height)`, or `None`
    /// (unknown/invalid/undecodable id — fail-closed).
    pub async fn info(asset_id: &str) -> Option<(u32, u32)> {
        let mut body = String::from("{\"assetId\":");
        json_escape(&mut body, asset_id);
        body.push('}');
        let (ok, bytes) = crate::host_call("host:asset", "info", body.into_bytes()).await;
        if ok != 1 {
            return None;
        }
        let w = parse_u32_field(&bytes, "width")?;
        let h = parse_u32_field(&bytes, "height")?;
        Some((w, h))
    }

    /// `host:asset.blit(id, dst)` → the host writes the asset's RGBA into `dst`
    /// (bounds-checked host-side; it refuses if `dst.len()` is smaller than
    /// `w*h*4`). Returns the bytes written on success, `None` on any failure
    /// (JS guest / bad id / too-small buffer — all fail-closed).
    ///
    /// Taking `&mut [u8]` (not a raw ptr/cap pair) is deliberate: the host will
    /// WRITE into this range, so safe Rust must only be able to hand it memory
    /// it exclusively owns — never an arbitrary pointer into its own heap.
    pub async fn blit(asset_id: &str, dst: &mut [u8]) -> Option<usize> {
        let dst_ptr = dst.as_mut_ptr() as usize;
        let dst_cap = dst.len();
        let mut body = String::from("{\"assetId\":");
        json_escape(&mut body, asset_id);
        body.push_str(&format!(",\"dstPtr\":{dst_ptr},\"dstCap\":{dst_cap}}}"));
        let (ok, bytes) = crate::host_call("host:asset", "blit", body.into_bytes()).await;
        if ok != 1 || !json_flag_true(&bytes, "ok") {
            return None;
        }
        parse_u32_field(&bytes, "written").map(|n| n as usize)
    }

    /// Convenience: `info` + allocate a `Surface` + `blit` into it. Returns a
    /// `Surface` holding the asset's RGBA (ready to composite + `present`), or
    /// `None` if any step fails. The `Surface` is a normal guest allocation, so
    /// the usual "allocate once, reuse across frames" rule applies.
    pub async fn load(asset_id: &str) -> Option<Surface> {
        let (w, h) = info(asset_id).await?;
        let mut surface = Surface::new(w, h);
        let cap = surface.pixels().len();
        let written = blit(asset_id, surface.pixels_mut()).await?;
        // The host must have filled the WHOLE buffer, or the frame is incomplete.
        if written != cap {
            return None;
        }
        Some(surface)
    }

    /// Read an unsigned-integer JSON field (`"field":<digits>`) from a response
    /// body. Tiny hand parser — the guest is `no_std` with no JSON crate, and the
    /// host responses are small, fixed shapes. Saturates at `u32::MAX`.
    fn parse_u32_field(bytes: &[u8], field: &str) -> Option<u32> {
        let s = core::str::from_utf8(bytes).ok()?;
        let needle = format!("\"{field}\":");
        let start = s.find(&needle)? + needle.len();
        let mut val: u64 = 0;
        let mut any = false;
        for c in s[start..].chars() {
            if c.is_ascii_digit() {
                any = true;
                val = val
                    .saturating_mul(10)
                    .saturating_add((c as u8 - b'0') as u64);
                if val > u32::MAX as u64 {
                    return Some(u32::MAX);
                }
            } else if c == ' ' && !any {
                continue; // tolerate a space after the colon
            } else {
                break;
            }
        }
        if any {
            Some(val as u32)
        } else {
            None
        }
    }

    /// Whether a boolean JSON field is present and `true` (`"field":true`).
    fn json_flag_true(bytes: &[u8], field: &str) -> bool {
        core::str::from_utf8(bytes)
            .map(|s| s.contains(&format!("\"{field}\":true")))
            .unwrap_or(false)
    }
}

/// Typed wrapper over the `host:gpu` capability — a HOST-MEDIATED GPU surface for
/// native guests (stage ③-a, the "validated command buffer + host-preset pipelines"
/// prototype). The guest NEVER touches a real WebGPU / WebGL2 context. It only:
///   1. `configure(canvas_id, mode).await` — bind a `<Canvas>` to a gpu MODE,
///   2. `create_vertex_buffer` / `create_index_buffer` / `create_texture` — upload
///      resources and get back an OPAQUE integer `Handle` (buffers come from the
///      guest's OWN linear memory; textures come ONLY from an `assetId`, reusing the
///      ④ host:asset resolver — NEVER a guest URL),
///   3. build a [`CommandBuffer`] from the OPCODE WHITELIST and `submit` it — the
///      host validates every op + the per-submit COST BUDGET and REPLAYS it against
///      HOST-PRESET pipelines (see [`preset`]) with NO readback.
///
/// Seal (③-a scope — the wire shape follows the `host:gpu` seam of
/// `contracts/graphics-seams.json`, the repo's single authoritative source that
/// downstream host validators (their `host-gpu.ts`) must mirror):
///  - Opcode WHITELIST only: `SET_PIPELINE` / `SET_BINDGROUP` / `SET_VERTEX` /
///    `SET_INDEX` / `SET_VIEWPORT` / `BEGIN_PASS` / `DRAW` / `DRAW_INDEXED` /
///    `DRAW_INSTANCED` / `END_PASS` / `SUBMIT`. There is deliberately NO
///    `COMPILE_SHADER` and NO `READ_PIXELS` / `getBufferSubData` / readback of any
///    kind — the seal's isolation is the ABSENCE of those, not a runtime check.
///  - Pipelines are HOST PRESETS chosen by integer id ([`preset`]); a guest cannot
///    author WGSL/GLSL in ③-a. Guest-authored shaders are ③-b/③-c — DESIGN ONLY,
///    not implemented (see `docs/rill-canvas.zh.md` §11).
///  - Handles are opaque host-table integers; the guest never sees a real GPU
///    object or a raw pointer.
///  - A canvas has ONE mode (2D | present | webgl2 | webgpu). `configure` fails
///    closed if the canvas was already bound to a CONFLICTING mode.
///  - COST BUDGET (the load-bearing gate): the GPU is SHARED HARDWARE below the
///    per-origin process isolation the seal relies on, so a massive instanced draw
///    or extreme overdraw can HANG the GPU → a driver TDR/reset that is
///    BROWSER-WIDE (every WebGL/WebGPU context in every tab). The host enforces a
///    per-submit budget (draw-call / primitive / instance / index / fill-pixel
///    caps) and DROPS an over-budget submit with a reason. [`CommandBuffer`] mirrors
///    those caps ([`Cost`] / [`CommandBuffer::within_budget`]) so a COOPERATIVE
///    guest self-limits; the host stays authoritative.
///  - host:gpu is NOT in the seal-safe (green) whitelist — a GPU app is its own
///    isolated origin but is NOT claimed green: TDR is a shared-hardware residual
///    that CSP / process isolation cannot contain.
pub mod gpu {
    use crate::json_escape;
    use alloc::format;
    use alloc::string::String;
    use alloc::vec::Vec;

    // ---- per-submit COST BUDGET + host-preset pipeline ids ----
    // GENERATED by build.rs from `contracts/graphics-seams.json` (host:gpu.budget
    // / .presets) — the single authoritative source for the graphics seam
    // contracts. Downstream host validators align to THAT file, never to this
    // crate; src/conformance.rs locks the rest of the wire shape to it too.
    include!(concat!(env!("OUT_DIR"), "/graphics_contract.rs"));

    /// The gpu backend a canvas is configured for. `configure` fails closed if the
    /// canvas is already in a conflicting mode (2D / present / the other gpu mode).
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub enum Mode {
        /// WebGPU (preferred; command-buffer native).
        Webgpu,
        /// WebGL2 fallback (host emulates the same preset pipelines).
        Webgl2,
    }
    impl Mode {
        fn as_str(self) -> &'static str {
            match self {
                Mode::Webgpu => "webgpu",
                Mode::Webgl2 => "webgl2",
            }
        }
    }

    /// Index element width for `SET_INDEX`.
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub enum IndexFormat {
        /// 16-bit indices.
        Uint16,
        /// 32-bit indices.
        Uint32,
    }
    impl IndexFormat {
        fn as_str(self) -> &'static str {
            match self {
                IndexFormat::Uint16 => "uint16",
                IndexFormat::Uint32 => "uint32",
            }
        }
    }

    /// An OPAQUE resource handle: an integer key into the host's per-canvas
    /// handle→realObject table. The guest never sees the real GPU object.
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub struct Handle(u32);
    impl Handle {
        /// The raw handle id (as it travels on the wire).
        pub fn id(self) -> u32 {
            self.0
        }
    }

    /// Running COST estimate of a [`CommandBuffer`], the guest-side mirror of the
    /// host's per-submit budget. A cooperative guest checks `within_budget` before
    /// `submit`; the host recomputes + enforces regardless (fail-closed).
    #[derive(Default, Clone, Copy)]
    pub struct Cost {
        /// Total ops (any opcode).
        pub cmds: usize,
        /// DRAW* ops.
        pub draw_calls: usize,
        /// Triangles summed over the submit (count/3 × instances).
        pub primitives: u64,
        /// Instances summed over the submit.
        pub instances: u64,
        /// Estimated shaded pixels (Σ current-viewport-area × instances).
        pub pixels: u64,
    }

    /// A validated GPU command buffer. Chain ops from the OPCODE WHITELIST, then
    /// `gpu::submit(id, &cmds).await`. Serializes to EXACTLY the op-list of
    /// `contracts/graphics-seams.json` `host:gpu.ops` (op names + field names —
    /// the authoritative schema the downstream host validator also mirrors); an
    /// unknown/over-budget op would be dropped host-side, so build valid ops here.
    ///
    /// The builder also tracks a [`Cost`] estimate as ops are added so a cooperative
    /// guest can `within_budget()` before submitting (the host is authoritative).
    #[derive(Default)]
    pub struct CommandBuffer {
        ops: String,
        cost: Cost,
        // Current viewport area (device px) for the fill-rate estimate; 0 until the
        // guest sets one, in which case pixel accounting is skipped guest-side (the
        // host applies the real canvas dimensions).
        viewport_area: u64,
        // Latched when a SINGLE draw exceeds a per-draw cap (elements/instances).
        // Those caps are not running sums, so they can't be checked in
        // within_budget() from `cost` alone — one oversized draw is a violation
        // on its own even if the submit totals look fine.
        violated: bool,
        // Latched when an op was fed a non-finite float: NaN/inf format as
        // `NaN`/`inf` — not legal JSON — so one bad op would make the whole
        // submit unparseable host-side. Skip the op, latch, fail loud in submit().
        non_finite: bool,
    }

    impl CommandBuffer {
        /// A fresh, empty command buffer.
        pub fn new() -> Self {
            Self::default()
        }

        fn push(&mut self, op: String) {
            if !self.ops.is_empty() {
                self.ops.push(',');
            }
            self.ops.push_str(&op);
            self.cost.cmds += 1;
        }

        /// `BEGIN_PASS` — open a render pass on the configured canvas, clearing to
        /// the given straight-alpha color (each channel in `[0, 1]`).
        // Guard for float-taking ops: non-finite input skips the op and
        // latches the buffer invalid (see `non_finite`).
        fn finite(&mut self, vals: &[f32]) -> bool {
            if vals.iter().all(|v| v.is_finite()) {
                true
            } else {
                self.non_finite = true;
                false
            }
        }

        /// Whether every op so far had finite numeric arguments. A `false`
        /// buffer is rejected by [`submit`] before it reaches the host.
        pub fn is_valid(&self) -> bool {
            !self.non_finite
        }

        pub fn begin_pass(&mut self, r: f32, g: f32, b: f32, a: f32) -> &mut Self {
            if !self.finite(&[r, g, b, a]) {
                return self;
            }
            self.push(format!(
                "{{\"op\":\"BEGIN_PASS\",\"r\":{r},\"g\":{g},\"b\":{b},\"a\":{a}}}"
            ));
            self
        }

        /// `END_PASS` — close the current render pass.
        pub fn end_pass(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"END_PASS\"}"));
            self
        }

        /// `SET_PIPELINE` — bind a HOST-PRESET pipeline by id (see [`preset`]).
        pub fn set_pipeline(&mut self, preset_id: u32) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"SET_PIPELINE\",\"pipeline\":{preset_id}}}"
            ));
            self
        }

        /// `SET_BINDGROUP` — bind a resource group (e.g. a preset texture) to a slot.
        pub fn set_bind_group(&mut self, slot: u32, group: Handle) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"SET_BINDGROUP\",\"slot\":{slot},\"group\":{}}}",
                group.0
            ));
            self
        }

        /// `SET_VERTEX` — bind a vertex buffer handle to slot 0.
        pub fn set_vertex(&mut self, buffer: Handle) -> &mut Self {
            self.set_vertex_slot(0, buffer)
        }

        /// `SET_VERTEX` — bind a vertex buffer handle to an explicit slot.
        pub fn set_vertex_slot(&mut self, slot: u32, buffer: Handle) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"SET_VERTEX\",\"slot\":{slot},\"buffer\":{}}}",
                buffer.0
            ));
            self
        }

        /// `SET_INDEX` — bind an index buffer handle + its element format.
        pub fn set_index(&mut self, buffer: Handle, format: IndexFormat) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"SET_INDEX\",\"buffer\":{},\"format\":\"{}\"}}",
                buffer.0,
                format.as_str()
            ));
            self
        }

        /// `SET_VIEWPORT` — restrict rasterization to a rectangle (device px). Also
        /// sets the fill-rate estimate's current area for subsequent draws.
        pub fn set_viewport(&mut self, x: f32, y: f32, w: f32, h: f32) -> &mut Self {
            if !self.finite(&[x, y, w, h]) {
                return self;
            }
            let aw = if w > 0.0 { w as u64 } else { 0 };
            let ah = if h > 0.0 { h as u64 } else { 0 };
            self.viewport_area = aw.saturating_mul(ah);
            self.push(format!(
                "{{\"op\":\"SET_VIEWPORT\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            self
        }

        /// `DRAW` — draw `count` vertices with the bound pipeline + vertex buffer.
        pub fn draw(&mut self, count: u32) -> &mut Self {
            self.account_draw(count, 1);
            self.push(format!("{{\"op\":\"DRAW\",\"count\":{count},\"first\":0}}"));
            self
        }

        /// `DRAW_INDEXED` — draw `count` indices with the bound index buffer.
        pub fn draw_indexed(&mut self, count: u32) -> &mut Self {
            self.account_draw(count, 1);
            self.push(format!(
                "{{\"op\":\"DRAW_INDEXED\",\"count\":{count},\"first\":0}}"
            ));
            self
        }

        /// `DRAW_INSTANCED` — draw `count` vertices × `instances` instances.
        pub fn draw_instanced(&mut self, count: u32, instances: u32) -> &mut Self {
            self.account_draw(count, instances);
            self.push(format!(
                "{{\"op\":\"DRAW_INSTANCED\",\"count\":{count},\"instances\":{instances},\"firstInstance\":0}}"
            ));
            self
        }

        /// `SUBMIT` — terminal op flushing the encoded pass to the queue. `submit()`
        /// (the RPC) appends this if the buffer does not already end with one.
        pub fn finish(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"SUBMIT\"}"));
            self
        }

        fn account_draw(&mut self, count: u32, instances: u32) {
            // Per-draw caps, mirroring the host's per-op validation: a single
            // draw over MAX_ELEMENTS_PER_DRAW / MAX_INSTANCES_PER_DRAW would be
            // dropped host-side, so latch `violated` and let within_budget()
            // report it before the guest wastes the submit.
            if count > MAX_ELEMENTS_PER_DRAW || instances > MAX_INSTANCES_PER_DRAW {
                self.violated = true;
            }
            self.cost.draw_calls += 1;
            let tris = (count as u64) / 3;
            self.cost.primitives = self
                .cost
                .primitives
                .saturating_add(tris.saturating_mul(instances as u64));
            self.cost.instances = self.cost.instances.saturating_add(instances as u64);
            // Fill proxy = area × PRIMITIVES (tris × instances), not area × instances:
            // else full-screen triangles in non-instanced draws slip the budget and
            // TDR the shared GPU. Matches `contracts/graphics-seams.json`
            // `host:gpu.costFormula` (the host recomputes it; authoritative).
            self.cost.pixels = self.cost.pixels.saturating_add(
                self.viewport_area
                    .saturating_mul(tris.saturating_mul(instances as u64)),
            );
        }

        /// The current cost estimate.
        pub fn cost(&self) -> Cost {
            self.cost
        }

        /// Number of ops queued.
        pub fn len(&self) -> usize {
            self.cost.cmds
        }
        /// Whether the buffer has no ops.
        pub fn is_empty(&self) -> bool {
            self.cost.cmds == 0
        }

        /// Whether this buffer is within the per-submit COST BUDGET (the same caps
        /// the host enforces). A cooperative guest checks this before `submit`; an
        /// over-budget buffer is dropped host-side with a reason regardless.
        pub fn within_budget(&self) -> bool {
            let c = &self.cost;
            !self.violated
                && c.cmds <= MAX_CMDS
                && c.draw_calls <= MAX_DRAW_CALLS
                && c.primitives <= MAX_PRIMITIVES
                && c.instances <= MAX_INSTANCES_TOTAL
                && c.pixels <= MAX_PIXELS
        }
    }

    /// `host:gpu.configure` — bind `<Canvas>` `canvas_id` to a gpu `mode`. Returns
    /// `true` on success, `false` if the canvas is unknown or already in a
    /// CONFLICTING mode (2D / present / the other gpu backend) — fail-closed.
    pub async fn configure(canvas_id: &str, mode: Mode) -> bool {
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(",\"mode\":\"");
        body.push_str(mode.as_str());
        body.push_str("\"}");
        let (ok, bytes) = crate::host_call("host:gpu", "configure", body.into_bytes()).await;
        ok == 1 && json_flag_true(&bytes, "ok")
    }

    /// `host:gpu.createResource(kind:"vertex")` — upload `data` (raw bytes in the
    /// guest's OWN linear memory) as a vertex buffer; returns an opaque [`Handle`].
    /// The host slice-COPIES the bytes (bounds-checked, byte-budgeted). `None` on
    /// any failure (over-cap size / bad canvas / OOB ptr — all fail-closed).
    pub async fn create_vertex_buffer(canvas_id: &str, data: &[u8]) -> Option<Handle> {
        create_buffer(canvas_id, "vertex", data, None).await
    }

    /// `host:gpu.createResource(kind:"index")` — upload `data` as an index buffer
    /// of the given `format`; returns an opaque [`Handle`]. `None` on failure.
    pub async fn create_index_buffer(
        canvas_id: &str,
        data: &[u8],
        format: IndexFormat,
    ) -> Option<Handle> {
        create_buffer(canvas_id, "index", data, Some(format)).await
    }

    async fn create_buffer(
        canvas_id: &str,
        kind: &str,
        data: &[u8],
        format: Option<IndexFormat>,
    ) -> Option<Handle> {
        if data.len() > MAX_BUFFER_BYTES {
            return None; // over the buffer cap; don't even ask the host
        }
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(",\"kind\":\"");
        body.push_str(kind);
        body.push_str(&format!(
            "\",\"ptr\":{},\"len\":{}",
            data.as_ptr() as usize,
            data.len()
        ));
        if let Some(f) = format {
            body.push_str(",\"format\":\"");
            body.push_str(f.as_str());
            body.push('"');
        }
        body.push('}');
        let (ok, bytes) = crate::host_call("host:gpu", "createResource", body.into_bytes()).await;
        if ok != 1 || !json_flag_true(&bytes, "ok") {
            return None;
        }
        parse_u32_field(&bytes, "handle").map(Handle)
    }

    /// `host:gpu.createResource(kind:"texture")` — upload the app-package asset
    /// `asset_id` (④ host:asset discipline: host-resolved, same-origin raster only,
    /// dimension-capped) as a texture; returns an opaque [`Handle`]. NEVER accepts a
    /// guest URL. `None` on any failure (fail-closed).
    pub async fn create_texture(canvas_id: &str, asset_id: &str) -> Option<Handle> {
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(",\"kind\":\"texture\",\"assetId\":");
        json_escape(&mut body, asset_id);
        body.push('}');
        let (ok, bytes) = crate::host_call("host:gpu", "createResource", body.into_bytes()).await;
        if ok != 1 || !json_flag_true(&bytes, "ok") {
            return None;
        }
        parse_u32_field(&bytes, "handle").map(Handle)
    }

    /// `host:gpu.submit` — hand the host `cmds` to VALIDATE (opcode whitelist +
    /// per-submit cost budget) and REPLAY against the host-preset pipelines bound to
    /// `canvas_id`. Returns `Ok(response)` (`{"ok":true,"dropped":n}`) or
    /// `Err(response)` (`{"ok":false,"reason":"…"}`) if the host fails closed
    /// (unknown/unconfigured canvas, over-budget, device lost). The buffer is sent
    /// as-is; if it does not already end with a `SUBMIT` op the host appends one.
    pub async fn submit(canvas_id: &str, cmds: &CommandBuffer) -> Result<Vec<u8>, Vec<u8>> {
        if !cmds.is_valid() {
            // Fail loud guest-side: a non-finite op would have produced invalid
            // JSON and the host would drop the whole submit with no reason.
            return Err(Vec::from(
                &b"{\"ok\":false,\"reason\":\"non-finite number in command buffer\"}"[..],
            ));
        }
        let mut body = String::from("{\"canvasId\":");
        json_escape(&mut body, canvas_id);
        body.push_str(",\"ops\":[");
        body.push_str(&cmds.ops);
        body.push_str("]}");
        let (ok, bytes) = crate::host_call("host:gpu", "submit", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// Subscribe to `host:gpu.onDeviceLost` — the host emits this (like
    /// `host:canvas.onFrame`) when the GPU device/context is lost (a driver TDR or
    /// context-loss, possibly caused by ANOTHER app on the shared GPU). The handler
    /// receives the raw payload (`{"canvasId":"…","reason":"…"}`); a robust guest
    /// re-`configure`s + re-uploads its resources on this signal. Returns a
    /// subscription id for [`crate::events::off`].
    pub fn on_device_lost(handler: impl Fn(&[u8]) + 'static) -> u32 {
        crate::events::on("gpu.deviceLost", handler)
    }

    /// Read an unsigned-integer JSON field (`"field":<digits>`). Tiny hand parser
    /// (no_std, no JSON crate; host responses are small fixed shapes).
    fn parse_u32_field(bytes: &[u8], field: &str) -> Option<u32> {
        let s = core::str::from_utf8(bytes).ok()?;
        let needle = format!("\"{field}\":");
        let start = s.find(&needle)? + needle.len();
        let mut val: u64 = 0;
        let mut any = false;
        for c in s[start..].chars() {
            if c.is_ascii_digit() {
                any = true;
                val = val
                    .saturating_mul(10)
                    .saturating_add((c as u8 - b'0') as u64);
                if val > u32::MAX as u64 {
                    return Some(u32::MAX);
                }
            } else if c == ' ' && !any {
                continue;
            } else {
                break;
            }
        }
        if any {
            Some(val as u32)
        } else {
            None
        }
    }

    /// Whether a boolean JSON field is present and `true` (`"field":true`).
    fn json_flag_true(bytes: &[u8], field: &str) -> bool {
        core::str::from_utf8(bytes)
            .map(|s| s.contains(&format!("\"{field}\":true")))
            .unwrap_or(false)
    }
}

/// Declarative UI: build a small element tree and `render` it. The guest sends a
/// render batch (CREATE / TEXT / APPEND ops) the host `receiver` materializes —
/// the same rendering path JS guests use, only the batch is authored in Rust.
pub mod ui {
    use alloc::string::String;
    use alloc::vec::Vec;

    /// A sealed UI node. `View` is a container; `Text` carries a string; `Canvas`
    /// mounts a viewport painted via host:canvas (draw / present).
    pub enum Node {
        View(Vec<Node>),
        Text(String),
        Canvas {
            canvas_id: String,
            width: u32,
            height: u32,
            /// Context family: "2d" (host:canvas draw/present) | "webgl2" | "webgpu"
            /// (host:gpu). A browser LOCKS a <canvas> to one family on first
            /// getContext, so this is fixed at mount and drives mode-exclusion.
            mode: String,
        },
    }

    /// A container node.
    pub fn view(children: Vec<Node>) -> Node {
        Node::View(children)
    }

    /// A text node.
    pub fn text(content: &str) -> Node {
        Node::Text(String::from(content))
    }

    /// A 2D canvas viewport node (host:canvas draw / present). The host mounts a
    /// real `<canvas>` of `width`×`height` logical pixels, keyed by `canvas_id`;
    /// the guest paints it ONLY through host:canvas — it never gets a handle to the
    /// element. That is the seal.
    pub fn canvas(canvas_id: &str, width: u32, height: u32) -> Node {
        canvas_mode(canvas_id, width, height, "2d")
    }

    /// A canvas viewport bound to a specific context family — "2d" (host:canvas),
    /// "webgl2" or "webgpu" (host:gpu). The family is fixed at mount; a host:gpu
    /// canvas must be created with the matching mode or host:gpu.configure fails
    /// closed. See [`crate::gpu`].
    pub fn canvas_mode(canvas_id: &str, width: u32, height: u32, mode: &str) -> Node {
        Node::Canvas {
            canvas_id: String::from(canvas_id),
            width,
            height,
            mode: String::from(mode),
        }
    }
}

/// Materialize `root` on the host: walk the tree into an operation batch
/// (`{version,batchId,operations:[…]}`, UTF-8 JSON) and hand it to the host's
/// render channel. One-way; no host round-trip.
pub fn render(root: ui::Node) {
    use alloc::format;
    use alloc::string::String;

    let mut ops = String::new();
    let mut next_id: u32 = 0;
    let root_id = emit_node(&mut ops, &root, &mut next_id);
    // Attach the root to the receiver root (parentId 0).
    push_op(
        &mut ops,
        format!("{{\"op\":\"APPEND\",\"id\":0,\"parentId\":0,\"childId\":{root_id}}}"),
    );

    let batch = format!("{{\"version\":1,\"batchId\":1,\"operations\":[{ops}]}}");
    let bytes = batch.into_bytes();
    unsafe { rill_send_batch(bytes.as_ptr(), bytes.len()) };
}

fn emit_node(ops: &mut alloc::string::String, node: &ui::Node, next_id: &mut u32) -> u32 {
    use alloc::format;
    *next_id += 1;
    let id = *next_id;
    match node {
        ui::Node::View(children) => {
            push_op(
                ops,
                format!("{{\"op\":\"CREATE\",\"id\":{id},\"type\":\"View\",\"props\":{{}}}}"),
            );
            for child in children {
                let child_id = emit_node(ops, child, next_id);
                push_op(
                    ops,
                    format!(
                        "{{\"op\":\"APPEND\",\"id\":0,\"parentId\":{id},\"childId\":{child_id}}}"
                    ),
                );
            }
        }
        ui::Node::Text(content) => {
            push_op(
                ops,
                format!("{{\"op\":\"CREATE\",\"id\":{id},\"type\":\"Text\",\"props\":{{}}}}"),
            );
            let mut escaped = alloc::string::String::new();
            json_escape(&mut escaped, content);
            push_op(
                ops,
                format!("{{\"op\":\"TEXT\",\"id\":{id},\"text\":{escaped}}}"),
            );
        }
        ui::Node::Canvas {
            canvas_id,
            width,
            height,
            mode,
        } => {
            let mut cid = alloc::string::String::new();
            json_escape(&mut cid, canvas_id);
            let mut m = alloc::string::String::new();
            json_escape(&mut m, mode);
            push_op(
                ops,
                format!(
                    "{{\"op\":\"CREATE\",\"id\":{id},\"type\":\"Canvas\",\"props\":{{\"canvasId\":{cid},\"mode\":{m},\"style\":{{\"width\":{width},\"height\":{height}}}}}}}"
                ),
            );
        }
    }
    id
}

fn push_op(ops: &mut alloc::string::String, op: alloc::string::String) {
    if !ops.is_empty() {
        ops.push(',');
    }
    ops.push_str(&op);
}

/// Escape `raw` into `out` as a double-quoted JSON string literal.
///
/// The ONE JSON string emitter for every wire path in this SDK (store / canvas /
/// asset / gpu request bodies and the render batch). Escapes `"` and `\`, plus
/// ALL control characters below 0x20 — `\n` / `\r` / `\t` as short escapes, the
/// rest as `\u00XX`. Multi-byte UTF-8 passes through unchanged.
///
/// A missed control character is not cosmetic: the host `JSON.parse`s the whole
/// batch/body, and one raw newline inside a string makes the ENTIRE message
/// invalid — silently dropped host-side. So this must stay strict, and every
/// module must use this function rather than growing a local copy.
/// Format a codec [`store_net_encode::Reason`] as a compact `{"error":"<token>"}`
/// JSON body, so a byte wrapper can surface a fail-closed cap breach through its
/// `Err(Vec<u8>)` channel using the schema's stable reason vocabulary.
pub(crate) fn codec_error(reason: store_net_encode::Reason) -> alloc::vec::Vec<u8> {
    let mut s = alloc::string::String::from("{\"error\":");
    json_escape(&mut s, reason.as_str());
    s.push('}');
    s.into_bytes()
}

pub(crate) fn json_escape(out: &mut alloc::string::String, raw: &str) {
    out.push('"');
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let v = c as u32;
                out.push_str("\\u00");
                out.push(HEX[(v >> 4) as usize & 0xf] as char);
                out.push(HEX[v as usize & 0xf] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Host -> guest events (input, lifecycle). Register handlers with `events::on`;
/// the host delivers them via the generated `rill_on_event` export. Handlers are
/// synchronous — they should update guest state, not `.await` host calls (a
/// dropped future would fire the call but never receive its result).
pub mod events {
    use alloc::rc::Rc;
    use alloc::string::String;
    use alloc::vec::Vec;

    // Rc, not Box: dispatch snapshots the matching handlers' Rc before calling
    // them, so a handler that mutates HANDLERS mid-dispatch (e.g. `off(self)` for
    // a one-shot subscription, or `on(...)`) can't invalidate the iteration or
    // free a handler being called. Single-threaded wasm, so Rc is fine.
    type Handler = Rc<dyn Fn(&[u8])>;
    static mut HANDLERS: Vec<(u32, String, Handler)> = Vec::new();
    static mut NEXT_ID: u32 = 1;

    /// Register `handler` for events named `name`; returns a subscription id.
    /// The handler receives the raw payload bytes (UTF-8 JSON) to parse as needed.
    pub fn on(name: &str, handler: impl Fn(&[u8]) + 'static) -> u32 {
        unsafe {
            let id = NEXT_ID;
            NEXT_ID += 1;
            HANDLERS.push((id, String::from(name), Rc::new(handler)));
            id
        }
    }

    /// Remove a previously registered handler by its subscription id.
    pub fn off(id: u32) {
        unsafe { HANDLERS.retain(|h| h.0 != id) };
    }

    /// Deliver an event to matching handlers. Called by the generated
    /// `rill_on_event` export.
    ///
    /// # Safety
    /// The pointer/length pairs must describe valid guest memory — upheld by the
    /// host, which wrote them via `rill_alloc` before calling `rill_on_event`.
    pub unsafe fn dispatch(
        name_ptr: *const u8,
        name_len: usize,
        payload_ptr: *const u8,
        payload_len: usize,
    ) {
        crate::rt::begin_wire_turn();
        let name =
            core::str::from_utf8(core::slice::from_raw_parts(name_ptr, name_len)).unwrap_or("");
        let payload = core::slice::from_raw_parts(payload_ptr, payload_len);
        // Snapshot matching handlers first: cloning the Rc keeps each alive for
        // the call even if a handler removes it from HANDLERS mid-dispatch.
        let matched: Vec<Handler> = HANDLERS
            .iter()
            .filter(|h| h.1 == name)
            .map(|h| h.2.clone())
            .collect();
        for handler in &matched {
            handler(payload);
        }
        crate::rt::end_wire_turn();
    }
}

/// RBS1 binary-value ENVELOPE codec (`contracts/store-net-bytes.json`) — the R2
/// first-class-bytes wire. ADDITIVE INFRA: compiled into the shipped guest
/// (unlike the `wip-binary-protocol` encoders), but it changes NO existing
/// call's default path — a segment-free value stays byte-for-byte identical to
/// today's raw JSON. See the module docs for the framing + value-walking layers.
pub mod store_net_encode;

/// Generate the ABI exports (`rill_init` / `rill_alloc` / `rill_resolve`), the
/// global allocator, and a panic handler in the guest cdylib. `$main` is an
/// `async fn () -> ()`.
#[macro_export]
macro_rules! rill_guest_main {
    ($main:path) => {
        // talc, memory.grow-backed and growable: the guest heap grows to fit the
        // working set then plateaus, reusing freed memory (see the SDK crate root).
        #[global_allocator]
        static __RILL_GUEST_ALLOC: $crate::WasmDynamicTalc = $crate::new_wasm_dynamic_allocator();

        #[panic_handler]
        fn __rill_guest_panic(info: &core::panic::PanicInfo) -> ! {
            // First report the panic location/message through env.rill_log (a
            // fixed stack buffer — no allocation, since the panic may BE an
            // allocation failure). Without this a native guest dies with zero
            // diagnostics.
            $crate::rt::panic_log(info);
            // Then trap, don't spin: a panicking / aborting guest (incl.
            // allocation failure) surfaces to the host as a catchable WASM error
            // instead of an infinite loop that would hang the host's main
            // thread. (A guest that spins on its own is a separate concern —
            // see the Worker path.)
            core::arch::wasm32::unreachable()
        }

        #[no_mangle]
        pub extern "C" fn rill_init() {
            $crate::rt::init($main());
        }

        #[no_mangle]
        pub extern "C" fn rill_abi_version() -> u32 {
            $crate::RILL_ABI_VERSION
        }

        #[no_mangle]
        pub extern "C" fn rill_alloc(size: usize) -> *mut u8 {
            $crate::rt::alloc(size)
        }

        // FFI export: the host passes a raw pointer by ABI contract.
        #[allow(clippy::not_unsafe_ptr_arg_deref)]
        #[no_mangle]
        pub extern "C" fn rill_resolve(cb: u32, ok: u32, ptr: *const u8, len: usize) {
            // Safety: the host wrote `len` bytes at `ptr` via rill_alloc before calling.
            unsafe { $crate::rt::resolve(cb, ok, ptr, len) };
        }

        // FFI export: the host delivers an event (name + payload) into the guest.
        #[allow(clippy::not_unsafe_ptr_arg_deref)]
        #[no_mangle]
        pub extern "C" fn rill_on_event(
            name_ptr: *const u8,
            name_len: usize,
            payload_ptr: *const u8,
            payload_len: usize,
        ) {
            // Safety: the host wrote both ranges via rill_alloc before calling.
            unsafe { $crate::events::dispatch(name_ptr, name_len, payload_ptr, payload_len) };
        }
    };
}

// ---- unit tests (run on the HOST target: `cargo test -p rill-guest`) ----
//
// The crate is `no_std`, but libtest brings std, so pure-logic tests (JSON
// escaping, gpu budget accounting) run natively. The wasm host imports get
// stub definitions below so the test binary links without a wasm host; the
// `rill_host_call` stub RECORDS each call so the conformance tests can assert
// the exact wire bytes against `contracts/graphics-seams.json`.
#[cfg(test)]
extern crate std;

/// Guest-side encoder for the binary op-batch wire protocol
/// (`contracts/op-batch-wire.json`). WORK IN PROGRESS, gated behind the
/// `wip-binary-protocol` feature (default OFF) and NOT wired into the live
/// op-batch emit path — new code only, so the shipped guest is unchanged.
#[cfg(feature = "wip-binary-protocol")]
pub mod wire_encode;

/// Guest-side encoder for the binary CANVAS wire protocol
/// (`contracts/canvas-wire.json`) — a per-frame flat 2D display list, sister to
/// `wire_encode` (distinct magic `RCNV`). WORK IN PROGRESS, gated behind the
/// `wip-binary-protocol` feature (default OFF) and NOT wired into the live
/// `canvas::draw` emit path (which still ships JSON) — new code only, so the
/// shipped guest is unchanged.
#[cfg(feature = "wip-binary-protocol")]
pub mod canvas_encode;

/// Shared minimal JSON parser (also `include!`d by build.rs) — test-only here,
/// for reading the contract back in `conformance`.
#[cfg(test)]
mod mini_json;

/// Conformance tests locking this SDK's wire shapes + budgets to
/// `contracts/graphics-seams.json`.
#[cfg(test)]
mod conformance;

/// Tests for the RBS1 byte-value SDK wrappers (`store::put_bytes`/`get_bytes`,
/// `net::fetch_bytes`) — request/response wiretaps against the recording shim.
#[cfg(test)]
#[path = "store_net_wrappers_tests.rs"]
mod store_net_wrappers_tests;

// A net-live-bytes counting global allocator, wired ONLY for the test build
// (the real guest's allocator is talc, installed by `rill_guest_main!`). It
// wraps the system allocator and tracks the live heap so the return-path
// no-leak test can assert that many oversized host->guest returns free their
// talc-fallback source buffers (the leak the fix closes) rather than accumulate.
#[cfg(test)]
mod test_alloc {
    use core::sync::atomic::{AtomicUsize, Ordering};
    use std::alloc::{GlobalAlloc, Layout, System};

    /// Net live bytes handed out by the global allocator (alloc − dealloc).
    pub(crate) static LIVE: AtomicUsize = AtomicUsize::new(0);

    pub(crate) struct Counting;

    // SAFETY: pure pass-through to `System`; only bookkeeping is added.
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = System.alloc(layout);
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            System.dealloc(ptr, layout);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let p = System.alloc_zeroed(layout);
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let p = System.realloc(ptr, layout, new_size);
            if !p.is_null() {
                // realloc keeps the allocation live; adjust by the size delta.
                LIVE.fetch_add(new_size, Ordering::Relaxed);
                LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
}

#[cfg(test)]
#[global_allocator]
static COUNTING_ALLOC: test_alloc::Counting = test_alloc::Counting;

/// Serialize every test that touches the SDK's runtime statics (`rt::RESULTS` /
/// `rt::NEXT_CB` / `rt::WIRE_OFF` / `rt::TURN_DEPTH` / `events::HANDLERS`). Those
/// assume the single-threaded wasm world, but libtest runs tests on threads, so
/// concurrent `resolve`/`alloc` from two tests would corrupt the shared `Vec`
/// statics. One crate-wide lock (used by `conformance`, the wire-arena test and
/// the return-path no-leak test) makes them mutually exclusive.
#[cfg(test)]
pub(crate) fn wire_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod test_shims {
    use std::string::String;
    use std::sync::Mutex;
    use std::vec::Vec;

    /// One recorded `rill_host_call`: (module, method, body, cb_id).
    pub(crate) type RecordedCall = (String, String, Vec<u8>, u32);

    /// Every `rill_host_call` issued by a test. Tests that poll host-call
    /// futures serialize on `conformance::wire_lock` (the SDK's rt statics
    /// assume a single thread), then drain this.
    pub(crate) static CALLS: Mutex<Vec<RecordedCall>> = Mutex::new(Vec::new());

    #[no_mangle]
    extern "C" fn rill_host_call(
        mod_ptr: *const u8,
        mod_len: usize,
        method_ptr: *const u8,
        method_len: usize,
        in_ptr: *const u8,
        in_len: usize,
        cb_id: u32,
    ) {
        // Safety: the SDK always passes valid &str / &[u8] views it owns.
        let (module, method, input) = unsafe {
            (
                String::from_utf8_lossy(core::slice::from_raw_parts(mod_ptr, mod_len)).into_owned(),
                String::from_utf8_lossy(core::slice::from_raw_parts(method_ptr, method_len))
                    .into_owned(),
                core::slice::from_raw_parts(in_ptr, in_len).to_vec(),
            )
        };
        CALLS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((module, method, input, cb_id));
    }
    #[no_mangle]
    extern "C" fn rill_send_batch(_batch_ptr: *const u8, _batch_len: usize) {}
    #[no_mangle]
    extern "C" fn rill_log(_msg_ptr: *const u8, _msg_len: usize) {}
}

#[cfg(test)]
mod tests {
    use alloc::string::String;

    fn esc(raw: &str) -> String {
        let mut out = String::new();
        super::json_escape(&mut out, raw);
        out
    }

    #[test]
    fn json_escape_plain_passthrough() {
        assert_eq!(esc("hello"), "\"hello\"");
        assert_eq!(esc(""), "\"\"");
    }

    #[test]
    fn json_escape_quotes_and_backslash() {
        assert_eq!(esc(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn json_escape_common_controls_short_form() {
        assert_eq!(esc("a\nb\rc\td"), r#""a\nb\rc\td""#);
    }

    #[test]
    fn json_escape_other_controls_as_u00xx() {
        assert_eq!(
            esc("\u{0}\u{1}\u{b}\u{1f}"),
            "\"\\u0000\\u0001\\u000b\\u001f\""
        );
    }

    #[test]
    fn json_escape_multibyte_utf8_passthrough() {
        // CJK + emoji + latin-1: multi-byte sequences must pass through intact.
        let raw = "\u{4e2d}\u{6587} \u{1f389} \u{fc}";
        let mut expected = String::from("\"");
        expected.push_str(raw);
        expected.push('"');
        assert_eq!(esc(raw), expected);
    }

    #[test]
    fn json_escape_no_control_char_survives_raw() {
        for c in (0u32..0x20).filter_map(char::from_u32) {
            let mut s = String::new();
            s.push(c);
            let escaped = esc(&s);
            assert!(
                !escaped[1..escaped.len() - 1].contains(c),
                "control char {:#x} leaked through unescaped",
                c as u32
            );
        }
    }

    mod non_finite_guard {
        use crate::{canvas, gpu};

        #[test]
        fn draw_list_latches_on_nan_and_skips_the_op() {
            let mut list = canvas::DrawList::new();
            list.fill_rect(0.0, 0.0, 10.0, 10.0);
            assert!(list.is_valid());
            assert_eq!(list.len(), 1);
            list.line_to(f64::NAN, 1.0);
            assert!(!list.is_valid());
            assert_eq!(list.len(), 1, "non-finite op must not be queued");
            // Latch is sticky: later valid ops don't un-latch.
            list.fill_rect(1.0, 1.0, 2.0, 2.0);
            assert!(!list.is_valid());
        }

        #[test]
        fn draw_list_latches_on_infinity() {
            let mut list = canvas::DrawList::new();
            list.set_transform(1.0, 0.0, 0.0, f64::INFINITY, 0.0, 0.0);
            assert!(!list.is_valid());
            assert!(list.is_empty());
        }

        #[test]
        fn command_buffer_latches_on_non_finite() {
            let mut cb = gpu::CommandBuffer::new();
            cb.begin_pass(0.0, 0.0, 0.0, 1.0);
            assert!(cb.is_valid());
            cb.set_viewport(0.0, 0.0, f32::NAN, 100.0);
            assert!(!cb.is_valid());
            assert_eq!(cb.cost().cmds, 1, "non-finite op must not be queued");
        }
    }

    mod gpu_budget {
        use crate::gpu;

        #[test]
        fn small_buffer_is_within_budget() {
            let mut cb = gpu::CommandBuffer::new();
            cb.begin_pass(0.0, 0.0, 0.0, 1.0)
                .draw(3)
                .end_pass()
                .finish();
            assert!(cb.within_budget());
            assert_eq!(cb.cost().draw_calls, 1);
            assert_eq!(cb.cost().primitives, 1);
        }

        #[test]
        fn oversized_elements_in_one_draw_violate() {
            let mut cb = gpu::CommandBuffer::new();
            // Totals stay under MAX_PRIMITIVES; only the per-draw cap trips.
            cb.draw(gpu::MAX_ELEMENTS_PER_DRAW + 1);
            assert!(!cb.within_budget());
        }

        #[test]
        fn oversized_instances_in_one_draw_violate() {
            let mut cb = gpu::CommandBuffer::new();
            // Totals stay under MAX_INSTANCES_TOTAL; only the per-draw cap trips.
            cb.draw_instanced(3, gpu::MAX_INSTANCES_PER_DRAW + 1);
            assert!(!cb.within_budget());
        }

        #[test]
        fn per_draw_violation_latches() {
            let mut cb = gpu::CommandBuffer::new();
            cb.draw(gpu::MAX_ELEMENTS_PER_DRAW + 1);
            cb.draw(3); // a later fine draw must not clear the violation
            assert!(!cb.within_budget());
        }

        #[test]
        fn at_cap_draw_is_still_within_budget() {
            let mut cb = gpu::CommandBuffer::new();
            cb.draw_instanced(3, gpu::MAX_INSTANCES_PER_DRAW);
            assert!(cb.within_budget());
        }

        #[test]
        fn too_many_draw_calls_exceed_budget() {
            let mut cb = gpu::CommandBuffer::new();
            for _ in 0..=gpu::MAX_DRAW_CALLS {
                cb.draw(3);
            }
            assert!(!cb.within_budget());
        }

        #[test]
        fn instance_totals_accumulate_across_draws() {
            let mut cb = gpu::CommandBuffer::new();
            let per_draw = gpu::MAX_INSTANCES_PER_DRAW as u64; // within per-draw cap
            let draws = gpu::MAX_INSTANCES_TOTAL / per_draw + 1;
            for _ in 0..draws {
                cb.draw_instanced(3, per_draw as u32);
            }
            assert!(cb.cost().instances > gpu::MAX_INSTANCES_TOTAL);
            assert!(!cb.within_budget());
        }

        #[test]
        fn fill_rate_pixels_use_viewport_area_times_primitives() {
            let mut cb = gpu::CommandBuffer::new();
            cb.set_viewport(0.0, 0.0, 100.0, 100.0);
            cb.draw_instanced(6, 2); // 2 tris x 2 instances = 4 primitives
            assert_eq!(cb.cost().pixels, 100 * 100 * 4);
        }
    }

    // These tests exercise the two leak-mitigation mechanisms. `wire_arena_*`
    // reads/writes SHARED statics (WIRE / WIRE_OFF / TURN_DEPTH via rt::*); cargo
    // test runs #[test]s on separate threads, so every assertion for that static
    // group is kept inside a SINGLE #[test] function — splitting them would race.
    // `talc_reuses_freed_memory_under_churn` drives a talc allocator over its OWN
    // local arena (not the shared WIRE statics), so the two functions touch
    // disjoint memory and don't race each other; no other test touches either.
    mod leak_mitigation {
        use crate::rt;

        #[test]
        fn wire_arena_recycles_per_turn() {
            // Shares WIRE_OFF/TURN_DEPTH with every other rt-touching test.
            let _guard = crate::wire_lock();
            let (lo, hi) = rt::wire_range();

            // Same turn: consecutive allocs bump upward, all inside the arena.
            let a = rt::alloc(16) as usize;
            let b = rt::alloc(16) as usize;
            assert!(b > a, "consecutive wire allocs must increase");
            assert!(a >= lo && b < hi, "wire allocs must land in the arena");

            // A closed turn (depth 1 -> 0) recycles the arena to its start.
            rt::begin_wire_turn();
            rt::end_wire_turn();
            let c = rt::alloc(16) as usize;
            assert_eq!(c, lo, "a closed turn must recycle the arena to its start");

            // Nested turns: the INNER end must NOT recycle (an outer turn may
            // still be reading its payload); only the OUTERMOST end recycles.
            rt::begin_wire_turn(); // depth 1
            let d = rt::alloc(16) as usize;
            rt::begin_wire_turn(); // depth 2
            rt::end_wire_turn(); // depth 1 — no recycle
            let e = rt::alloc(16) as usize;
            assert!(e > d, "inner turn end must not rewind the arena");
            rt::end_wire_turn(); // depth 0 — recycle
            let f = rt::alloc(16) as usize;
            assert_eq!(f, lo, "outermost turn end must recycle the arena");

            // An oversized request falls back to the global heap (talc), OUTSIDE
            // the arena range.
            let big = rt::alloc(rt::WIRE_SIZE + 1) as usize;
            assert!(
                big < lo || big >= hi,
                "oversized alloc must fall back off-arena"
            );
        }

        // Supersedes the retired `bump_dealloc_rolls_back_lifo_top`. That test
        // pinned BumpAlloc's exact LIFO-top offset rollback — a MECHANISM detail
        // of an allocator that no longer exists, never a host-observable contract
        // (the host only ever sees valid buffers through the ABI). talc replaces
        // that only-grows bump with a real free list, so the invariant that
        // actually matters now — the guest heap is BOUNDED under alloc/free churn,
        // reclaiming freed blocks regardless of order — is what this asserts. It
        // drives talc directly (the same allocator wired as the guest
        // #[global_allocator]) over a small fixed arena on the host target.
        #[test]
        fn talc_reuses_freed_memory_under_churn() {
            use alloc::vec::Vec;
            use core::alloc::{GlobalAlloc, Layout};
            use talc::{source::Claim, TalcCell};

            // Deliberately small: far less than the total bytes churned below, so
            // the test only passes if freed memory is actually reused (a leaking
            // allocator would exhaust the arena long before the loop ends).
            const ARENA_SIZE: usize = 64 * 1024;
            static mut ARENA: [u8; ARENA_SIZE] = [0; ARENA_SIZE];
            // SAFETY: ARENA is touched only here, only on this single test thread,
            // and handed exclusively to this talc instance for its lifetime.
            let talc = TalcCell::new(unsafe { Claim::array(&raw mut ARENA) });

            let layout = Layout::from_size_align(256, 16).unwrap();
            unsafe {
                // Churn far more than the arena holds; each iteration frees before
                // the next allocates, so a bounded allocator serves every request.
                for _ in 0..2000 {
                    let p = talc.alloc(layout);
                    assert!(!p.is_null(), "talc must reuse freed memory, not exhaust");
                    p.write_bytes(0xAB, layout.size()); // touch: catch a bogus ptr
                    talc.dealloc(p, layout);
                }

                // Non-LIFO (FIFO) reclamation: hold several blocks live, then free
                // the OLDEST first — the interleaved-lifetime case the old bump
                // allocator LEAKED. A real free list makes the room available again.
                let mut live = Vec::new();
                for _ in 0..8 {
                    let p = talc.alloc(layout);
                    assert!(!p.is_null());
                    live.push(p);
                }
                for p in live.drain(..) {
                    talc.dealloc(p, layout); // oldest-first
                }
                // Everything freed: a full round of allocations succeeds again.
                for _ in 0..8 {
                    let p = talc.alloc(layout);
                    assert!(!p.is_null(), "FIFO-freed blocks must be reclaimable");
                    talc.dealloc(p, layout);
                }
            }
        }

        // RETURN-PATH no-leak proof (the fix in `rt::resolve`). A host->guest
        // return larger than the 64 KiB WIRE arena is written into a talc-fallback
        // buffer by `rill_alloc`; before the fix that buffer had no matching
        // dealloc, so every large binary RESPONSE leaked. This drives that exact
        // path many times — allocate an oversized buffer (off-arena), hand it to
        // `resolve` (which copies it out then frees the fallback), then drain the
        // copy — and asserts the net live heap returns to baseline. Extends the
        // plateau discipline of the churn test above: hundreds of MiB flow through
        // the return path yet the heap stays bounded. Without the fix, live would
        // grow by iterations*BIG (tens of MiB) and this assertion would fail.
        //
        // Uses the test-build counting global allocator (`test_alloc::LIVE`).
        // Concurrent tests perturb the counter only by small allocations, far
        // below the multi-MiB threshold, so the delta stays attributable here.
        #[test]
        fn return_path_frees_oversized_fallback_no_leak() {
            use crate::rt;

            // Serialize with every other rt-static-touching test (RESULTS/WIRE_OFF).
            let _guard = crate::wire_lock();

            // Comfortably larger than WIRE_SIZE so every request takes the
            // off-arena talc fallback (the only path that could leak).
            const BIG: usize = rt::WIRE_SIZE + 4096;
            const ITERS: usize = 64; // 64 × ~68 KiB ≈ 4.3 MiB churned per pass
            const CB: u32 = 0xB17E_5EED;

            // The fallback table is a process-global static, so a prior test may
            // have left dangling entries. We hold `wire_lock`, so no other
            // rt-touching test runs concurrently — the table's NET change across
            // this loop must therefore be zero (every fallback we make is freed by
            // `resolve`). Prior leftovers are present at both snapshots.
            let fb_baseline = rt::fallback_count();
            for _ in 0..ITERS {
                let p = rt::alloc(BIG);
                assert!(!p.is_null(), "fallback alloc must succeed");
                // Precondition of the fix: the buffer is OUTSIDE the WIRE arena,
                // so `resolve` is allowed to free it.
                assert!(
                    !rt::wire_contains(p),
                    "an oversized alloc must fall back off-arena"
                );
                // The host wrote BIG bytes here (uninitialized-but-owned memory is
                // fine to copy); `resolve` copies it out and frees the fallback.
                unsafe { rt::resolve(CB, 1, p, BIG) };
                // Drain the copy `resolve` stashed so RESULTS stays empty and the
                // only thing that could grow the heap is a leaked SOURCE buffer.
                let taken = rt::take_result(CB);
                assert!(taken.is_some(), "the copied result must be retrievable");
                drop(taken);
            }
            // DETERMINISTIC proof the fix works: the fallback table returned to
            // its baseline — every off-arena buffer THIS test made was freed by
            // `resolve` (a leak would leave up to ITERS tracked entries). Taken as
            // a delta so a prior test's leftover entries don't matter and — key for
            // a parallel run — the check is immune to concurrent global-heap noise.
            // That talc actually reclaims the freed bytes is proven separately by
            // the R3 churn/plateau test.
            assert_eq!(
                rt::fallback_count(),
                fb_baseline,
                "every oversized fallback must be freed (table back to baseline)"
            );
        }
    }
}
