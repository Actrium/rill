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
//! `rill_init`), a bump allocator, and a minimal single-task async executor. A
//! host call is a future: on first poll it issues `rill_host_call` and parks;
//! when the host later calls `rill_resolve(cb, …)` the executor re-polls and the
//! future completes. This is the guest side of the same callback-resolve model
//! the existing QuickJS bridge already uses.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
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

/// Send a UTF-8 diagnostic message to the host (`env.rill_log` → the host's
/// `onLog` sink). Fire-and-forget: the host may drop or ignore it, so use it
/// for observability, never as a data channel. This is a native guest's ONLY
/// window for "what went wrong" — the panic handler reports through it too.
pub fn log(msg: &str) {
    unsafe { rill_log(msg.as_ptr(), msg.len()) }
}

// ---- Bump allocator (leaks; fine for short-lived guests) ----
const HEAP_SIZE: usize = 1 << 20; // 1 MiB

/// Backing storage for the bump heap. The newtype exists for its `align(16)`:
/// a bare `[u8; N]` static is only guaranteed 1-byte alignment, so aligning
/// OFFSETS into it would not make the resulting ADDRESSES aligned. 16 covers
/// every layout the SDK itself allocates; `alloc` below additionally aligns
/// the actual address, so even rarer over-aligned requests stay correct.
#[repr(C, align(16))]
struct Heap([u8; HEAP_SIZE]);
static mut HEAP: Heap = Heap([0; HEAP_SIZE]);

pub struct BumpAlloc {
    offset: UnsafeCell<usize>,
}
// Single-threaded wasm: no real concurrency.
unsafe impl Sync for BumpAlloc {}
impl BumpAlloc {
    pub const fn new() -> Self {
        Self {
            offset: UnsafeCell::new(0),
        }
    }
}
impl Default for BumpAlloc {
    fn default() -> Self {
        Self::new()
    }
}
unsafe impl GlobalAlloc for BumpAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let off = &mut *self.offset.get();
        let base = addr_of_mut!(HEAP) as usize;
        // Align the ADDRESS handed out, not merely the offset: the offset math
        // only yields an aligned pointer if the heap base itself is at least as
        // aligned as the request, which `Heap`'s align(16) does not promise for
        // exotic (>16) alignments.
        let cur = match base.checked_add(*off) {
            Some(v) => v,
            None => return core::ptr::null_mut(),
        };
        let aligned_addr = match cur.checked_add(layout.align() - 1) {
            Some(v) => v & !(layout.align() - 1),
            None => return core::ptr::null_mut(),
        };
        let aligned = aligned_addr - base;
        let end = match aligned.checked_add(layout.size()) {
            Some(v) => v,
            None => return core::ptr::null_mut(),
        };
        if end > HEAP_SIZE {
            return core::ptr::null_mut();
        }
        *off = end;
        aligned_addr as *mut u8
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

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

    /// `rill_init` body: box the guest's async entry and drive it once.
    pub fn init(future: impl Future<Output = ()> + 'static) {
        unsafe {
            TASK = Some(alloc::boxed::Box::pin(future));
            poll();
        }
    }

    /// `rill_alloc` body: hand the host a buffer from the guest heap.
    pub fn alloc(size: usize) -> *mut u8 {
        unsafe { alloc::alloc::alloc(Layout::from_size_align_unchecked(size.max(1), 1)) }
    }

    /// `rill_resolve` body: stash the result for `cb` and re-drive the task.
    ///
    /// # Safety
    /// `ptr`/`len` must describe a valid buffer in guest memory — upheld by the
    /// host, which wrote the result there via `rill_alloc` before calling.
    pub unsafe fn resolve(cb: u32, ok: u32, ptr: *const u8, len: usize) {
        let bytes = if !ptr.is_null() && len > 0 {
            core::slice::from_raw_parts(ptr, len).to_vec()
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
    /// (bump heap exhausted). Truncation lands on a UTF-8 char boundary so the
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
/// The wire shape mirrors `host-canvas.ts` `OP_SPECS` EXACTLY (op names + arg
/// field names). Styles are color STRINGS only (no gradient/pattern object → no
/// image/URL reference), and there is deliberately NO readback — the seal's
/// isolation lives in the ABSENCE of those, not in a runtime check.
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
            self
        }
        /// `closePath()`.
        pub fn close_path(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"closePath\"}"));
            self
        }
        /// `moveTo(x, y)`.
        pub fn move_to(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"moveTo\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `lineTo(x, y)`.
        pub fn line_to(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"lineTo\",\"x\":{x},\"y\":{y}}}"));
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
            self
        }
        /// `fill()` the current path.
        pub fn fill(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"fill\"}"));
            self
        }
        /// `stroke()` the current path.
        pub fn stroke(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"stroke\"}"));
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
            self
        }

        // ---- styles (color is a CSS string only — never a gradient/pattern) ----
        /// `fillStyle = color` (CSS color string).
        pub fn set_fill_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setFillStyle\",\"color\":");
            json_escape(&mut s, color);
            s.push('}');
            self.push(s);
            self
        }
        /// `strokeStyle = color` (CSS color string).
        pub fn set_stroke_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setStrokeStyle\",\"color\":");
            json_escape(&mut s, color);
            s.push('}');
            self.push(s);
            self
        }
        /// `lineWidth = w`.
        pub fn set_line_width(&mut self, w: f64) -> &mut Self {
            if !self.finite(&[w]) {
                return self;
            }
            self.push(format!("{{\"op\":\"setLineWidth\",\"w\":{w}}}"));
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
            self
        }

        // ---- transform stack ----
        /// `save()` the drawing state.
        pub fn save(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"save\"}"));
            self
        }
        /// `restore()` the drawing state.
        pub fn restore(&mut self) -> &mut Self {
            self.push(String::from("{\"op\":\"restore\"}"));
            self
        }
        /// `translate(x, y)`.
        pub fn translate(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"translate\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `scale(x, y)`.
        pub fn scale(&mut self, x: f64, y: f64) -> &mut Self {
            if !self.finite(&[x, y]) {
                return self;
            }
            self.push(format!("{{\"op\":\"scale\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `rotate(angle)` (radians).
        pub fn rotate(&mut self, angle: f64) -> &mut Self {
            if !self.finite(&[angle]) {
                return self;
            }
            self.push(format!("{{\"op\":\"rotate\",\"angle\":{angle}}}"));
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
            self
        }
    }

    /// `host:canvas.draw` — replay `list` onto the `<Canvas>` named `canvas_id`.
    /// Returns `Ok(response)` (`{"ok":true,"dropped":n}`) or `Err(response)` if
    /// the host fails closed (e.g. unknown/unmounted canvas id).
    pub async fn draw(canvas_id: &str, list: &DrawList) -> Result<Vec<u8>, Vec<u8>> {
        if !list.is_valid() {
            // Fail loud guest-side: a non-finite op would have produced invalid
            // JSON and the host would drop the whole batch with no reason.
            return Err(Vec::from(
                &b"{\"error\":\"non-finite number in draw list\"}"[..],
            ));
        }
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
    /// `putImageData` contract the host blit expects. Backed by the guest's
    /// `BumpAlloc`, which only grows: allocate a Surface ONCE and reuse it across
    /// frames (a `Surface::new` per frame leaks its buffer for the guest's life).
    ///
    /// Double-buffering: `present(id, &surface).await` resolves only AFTER the host
    /// has finished reading these bytes, so with a single Surface it is already
    /// safe to overwrite for the next frame once the await returns (at most one
    /// frame in flight — the ack is the backpressure). A guest that wants to render
    /// frame N+1 while the host still blits frame N can instead allocate TWO
    /// Surfaces once and alternate them (write A / present B, then swap); the same
    /// "allocate once, BumpAlloc only grows" rule means the two buffers are made a
    /// single time and reused forever.
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
/// Seal (③-a scope — the wire shape mirrors `host-gpu.ts`'s validator EXACTLY):
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

    // ---- per-submit COST BUDGET (mirror of host-gpu.ts; host is authoritative) ----
    /// Max ops (any opcode) in one command buffer.
    pub const MAX_CMDS: usize = 4096;
    /// Max DRAW*/draw-call ops in one submit.
    pub const MAX_DRAW_CALLS: usize = 256;
    /// Max total primitives (triangles) summed over the submit.
    pub const MAX_PRIMITIVES: u64 = 4_000_000;
    /// Max instances in a single DRAW_INSTANCED.
    pub const MAX_INSTANCES_PER_DRAW: u32 = 4096;
    /// Max instances summed over the submit.
    pub const MAX_INSTANCES_TOTAL: u64 = 262_144;
    /// Max index/vertex count in a single draw.
    pub const MAX_ELEMENTS_PER_DRAW: u32 = 4_000_000;
    /// Max estimated SHADED pixels (fill-rate proxy = Σ viewport_area × instances).
    pub const MAX_PIXELS: u64 = 134_217_728; // ~128M px / submit
    /// Max bytes for one uploaded vertex/index buffer.
    pub const MAX_BUFFER_BYTES: usize = 64 * 1024 * 1024;

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

    /// HOST-PRESET pipeline ids. In ③-a the guest CANNOT author shaders; it picks
    /// one of these fixed, host-compiled pipelines by integer id. Adding a preset
    /// is a HOST change (audited), never a guest capability.
    pub mod preset {
        /// Flat-colored triangles from an interleaved `[x, y, r, g, b, a]` (f32)
        /// vertex buffer. No texture, no guest shader.
        pub const SOLID_2D: u32 = 0;
        /// Textured quad: samples a host-preset texture bind group whose texture
        /// came from an `assetId` (④ host:asset). Vertex buffer is `[x, y, u, v]`.
        pub const TEXTURED_2D: u32 = 1;
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
    /// `gpu::submit(id, &cmds).await`. Serializes to EXACTLY the op-list
    /// `host-gpu.ts` accepts (op names + field names match its `OP_SPECS`); an
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
            // TDR the shared GPU. Mirrors the host (host-gpu.ts, authoritative).
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
    }
}

/// Generate the ABI exports (`rill_init` / `rill_alloc` / `rill_resolve`), the
/// global allocator, and a panic handler in the guest cdylib. `$main` is an
/// `async fn () -> ()`.
#[macro_export]
macro_rules! rill_guest_main {
    ($main:path) => {
        #[global_allocator]
        static __RILL_GUEST_ALLOC: $crate::BumpAlloc = $crate::BumpAlloc::new();

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
// stub definitions below so the test binary links without a wasm host.
#[cfg(test)]
mod test_shims {
    #[no_mangle]
    extern "C" fn rill_host_call(
        _mod_ptr: *const u8,
        _mod_len: usize,
        _method_ptr: *const u8,
        _method_len: usize,
        _in_ptr: *const u8,
        _in_len: usize,
        _cb_id: u32,
    ) {
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
}
