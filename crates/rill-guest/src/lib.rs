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

/// Declarative UI: build a small element tree and `render` it. The guest sends a
/// render batch (CREATE / TEXT / APPEND ops) the host `receiver` materializes —
/// the same rendering path JS guests use, only the batch is authored in Rust.
pub mod ui {
    use alloc::string::String;
    use alloc::vec::Vec;

    /// A sealed UI node. `View` is a container; `Text` carries a string.
    pub enum Node {
        View(Vec<Node>),
        Text(String),
    }

    /// A container node.
    pub fn view(children: Vec<Node>) -> Node {
        Node::View(children)
    }

    /// A text node.
    pub fn text(content: &str) -> Node {
        Node::Text(String::from(content))
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
    use alloc::boxed::Box;
    use alloc::string::String;
    use alloc::vec::Vec;

    type Handler = Box<dyn Fn(&[u8])>;
    static mut HANDLERS: Vec<(u32, String, Handler)> = Vec::new();
    static mut NEXT_ID: u32 = 1;

    /// Register `handler` for events named `name`; returns a subscription id.
    /// The handler receives the raw payload bytes (UTF-8 JSON) to parse as needed.
    pub fn on(name: &str, handler: impl Fn(&[u8]) + 'static) -> u32 {
        unsafe {
            let id = NEXT_ID;
            NEXT_ID += 1;
            HANDLERS.push((id, String::from(name), Box::new(handler)));
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
        for (_, registered, handler) in HANDLERS.iter() {
            if registered == name {
                handler(payload);
            }
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
            loop {}
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
