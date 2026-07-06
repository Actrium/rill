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
}

// ---- Bump allocator (leaks; fine for short-lived guests) ----
const HEAP_SIZE: usize = 1 << 20; // 1 MiB
static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];

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
        let aligned = (*off + layout.align() - 1) & !(layout.align() - 1);
        let end = aligned + layout.size();
        if end > HEAP_SIZE {
            return core::ptr::null_mut();
        }
        *off = end;
        (addr_of_mut!(HEAP) as *mut u8).add(aligned)
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

/// Typed wrapper over the `host:kv` capability (demo).
pub mod store {
    use alloc::string::String;
    use alloc::vec::Vec;

    /// `host:kv.put(k, v)` -> the response body on success (`{"version":n}`).
    pub async fn put(k: &str, v: &str) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"k\":");
        push_json_string(&mut body, k);
        body.push_str(",\"v\":");
        push_json_string(&mut body, v);
        body.push('}');
        let (ok, bytes) = super::host_call("host:kv", "put", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    /// `host:kv.get(k)` -> the response body on success (`{"v":"…"}`).
    pub async fn get(k: &str) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"k\":");
        push_json_string(&mut body, k);
        body.push('}');
        let (ok, bytes) = super::host_call("host:kv", "get", body.into_bytes()).await;
        if ok == 1 {
            Ok(bytes)
        } else {
            Err(bytes)
        }
    }

    fn push_json_string(out: &mut String, raw: &str) {
        out.push('"');
        for ch in raw.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                _ => out.push(ch),
            }
        }
        out.push('"');
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
    }

    impl DrawList {
        /// A fresh, empty display list.
        pub fn new() -> Self {
            Self {
                ops: String::new(),
                count: 0,
            }
        }

        fn push(&mut self, op: String) {
            if !self.ops.is_empty() {
                self.ops.push(',');
            }
            self.ops.push_str(&op);
            self.count += 1;
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
            self.push(format!("{{\"op\":\"moveTo\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `lineTo(x, y)`.
        pub fn line_to(&mut self, x: f64, y: f64) -> &mut Self {
            self.push(format!("{{\"op\":\"lineTo\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `rect(x, y, w, h)` (adds a rectangle sub-path).
        pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"rect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            self
        }
        /// `arc(x, y, r, start, end)` counter-clockwise=false.
        pub fn arc(&mut self, x: f64, y: f64, r: f64, start: f64, end: f64) -> &mut Self {
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
            self.push(format!(
                "{{\"op\":\"fillRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            self
        }
        /// `strokeRect(x, y, w, h)`.
        pub fn stroke_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"strokeRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            self
        }
        /// `clearRect(x, y, w, h)`.
        pub fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
            self.push(format!(
                "{{\"op\":\"clearRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}"
            ));
            self
        }

        // ---- styles (color is a CSS string only — never a gradient/pattern) ----
        /// `fillStyle = color` (CSS color string).
        pub fn set_fill_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setFillStyle\",\"color\":");
            json_string(&mut s, color);
            s.push('}');
            self.push(s);
            self
        }
        /// `strokeStyle = color` (CSS color string).
        pub fn set_stroke_style(&mut self, color: &str) -> &mut Self {
            let mut s = String::from("{\"op\":\"setStrokeStyle\",\"color\":");
            json_string(&mut s, color);
            s.push('}');
            self.push(s);
            self
        }
        /// `lineWidth = w`.
        pub fn set_line_width(&mut self, w: f64) -> &mut Self {
            self.push(format!("{{\"op\":\"setLineWidth\",\"w\":{w}}}"));
            self
        }

        // ---- text ----
        /// `fillText(text, x, y)`.
        pub fn fill_text(&mut self, text: &str, x: f64, y: f64) -> &mut Self {
            let mut s = format!("{{\"op\":\"fillText\",\"x\":{x},\"y\":{y},\"text\":");
            json_string(&mut s, text);
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
            self.push(format!("{{\"op\":\"translate\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `scale(x, y)`.
        pub fn scale(&mut self, x: f64, y: f64) -> &mut Self {
            self.push(format!("{{\"op\":\"scale\",\"x\":{x},\"y\":{y}}}"));
            self
        }
        /// `rotate(angle)` (radians).
        pub fn rotate(&mut self, angle: f64) -> &mut Self {
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
            self.push(format!(
                "{{\"op\":\"setTransform\",\"a\":{a},\"b\":{b},\"c\":{c},\"d\":{d},\"e\":{e},\"f\":{f}}}"
            ));
            self
        }
    }

    /// Minimal JSON string emitter (host caps length; we escape control chars so
    /// the batch stays valid UTF-8 JSON regardless of guest input).
    fn json_string(out: &mut String, raw: &str) {
        out.push('"');
        for ch in raw.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }

    /// `host:canvas.draw` — replay `list` onto the `<Canvas>` named `canvas_id`.
    /// Returns `Ok(response)` (`{"ok":true,"dropped":n}`) or `Err(response)` if
    /// the host fails closed (e.g. unknown/unmounted canvas id).
    pub async fn draw(canvas_id: &str, list: &DrawList) -> Result<Vec<u8>, Vec<u8>> {
        let mut body = String::from("{\"canvasId\":");
        json_string(&mut body, canvas_id);
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
        json_string(&mut body, canvas_id);
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
///   3. `blit(id, ptr, cap)` → the host writes the RGBA into that buffer.
/// `load(id)` does all three and hands back a ready-to-composite `Surface`.
pub mod asset {
    use crate::canvas::Surface;
    use alloc::format;
    use alloc::string::String;

    /// `host:asset.info(id)` → the decoded asset's `(width, height)`, or `None`
    /// (unknown/invalid/undecodable id — fail-closed).
    pub async fn info(asset_id: &str) -> Option<(u32, u32)> {
        let mut body = String::from("{\"assetId\":");
        json_string(&mut body, asset_id);
        body.push('}');
        let (ok, bytes) = crate::host_call("host:asset", "info", body.into_bytes()).await;
        if ok != 1 {
            return None;
        }
        let w = parse_u32_field(&bytes, "width")?;
        let h = parse_u32_field(&bytes, "height")?;
        Some((w, h))
    }

    /// `host:asset.blit(id, dst_ptr, dst_cap)` → the host writes the asset's RGBA
    /// into guest memory at `dst_ptr` (bounds-checked host-side). `dst_cap` is the
    /// number of bytes the guest reserved there; the host refuses if it is smaller
    /// than `w*h*4`. Returns the bytes written on success, `None` on any failure
    /// (JS guest / bad id / OOB ptr / too-small cap — all fail-closed).
    pub async fn blit(asset_id: &str, dst_ptr: usize, dst_cap: usize) -> Option<usize> {
        let mut body = String::from("{\"assetId\":");
        json_string(&mut body, asset_id);
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
        // The host writes RGBA straight into this buffer's linear-memory range via
        // `blit(ptr, cap)`, so the binding stays immutable here (no `&mut` path).
        let surface = Surface::new(w, h);
        let cap = surface.pixels().len();
        let written = blit(asset_id, surface.ptr(), cap).await?;
        // The host must have filled the WHOLE buffer, or the frame is incomplete.
        if written != cap {
            return None;
        }
        Some(surface)
    }

    /// Minimal JSON string emitter (escapes control chars so the request stays
    /// valid UTF-8 JSON regardless of the id; the host caps/validates it anyway).
    fn json_string(out: &mut String, raw: &str) {
        out.push('"');
        for ch in raw.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
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
                val = val.saturating_mul(10).saturating_add((c as u8 - b'0') as u64);
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

    /// A canvas viewport node. The host mounts a real `<canvas>` of `width`×`height`
    /// logical pixels, keyed by `canvas_id`; the guest paints it ONLY through
    /// host:canvas (draw for a display list, present for a framebuffer) — it never
    /// gets a handle to the element. That is the seal.
    pub fn canvas(canvas_id: &str, width: u32, height: u32) -> Node {
        Node::Canvas {
            canvas_id: String::from(canvas_id),
            width,
            height,
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
        } => {
            let mut cid = alloc::string::String::new();
            json_escape(&mut cid, canvas_id);
            push_op(
                ops,
                format!(
                    "{{\"op\":\"CREATE\",\"id\":{id},\"type\":\"Canvas\",\"props\":{{\"canvasId\":{cid},\"style\":{{\"width\":{width},\"height\":{height}}}}}}}"
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

fn json_escape(out: &mut alloc::string::String, raw: &str) {
    out.push('"');
    for ch in raw.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
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
        fn __rill_guest_panic(_: &core::panic::PanicInfo) -> ! {
            // Trap, don't spin: a panicking / aborting guest (incl. allocation
            // failure) surfaces to the host as a catchable WASM error instead of
            // an infinite loop that would hang the host's main thread. (A guest
            // that spins on its own is a separate concern — see the Worker path.)
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
