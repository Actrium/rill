//! Demo native (non-JS) rill guest for the stage ③-a HOST-MEDIATED GPU path.
//!
//! It proves "host-mediated GPU" end to end WITHOUT ever touching a real
//! WebGPU/WebGL2 context: the guest only (1) configures a `<Canvas>` into a gpu
//! mode, (2) uploads a small vertex buffer from its OWN linear memory and gets an
//! opaque handle back, (3) picks a HOST-PRESET pipeline (no guest shader), and
//! (4) each frame submits a VALIDATED command buffer — begin pass / set pipeline /
//! set vertex / draw a triangle / end pass / submit — that the host validates
//! (opcode whitelist + per-submit cost budget) and replays. There is NO readback.
//!
//! Cost budget: one draw call, 3 vertices, 1 instance per frame — orders of
//! magnitude under the caps in `rill_guest::gpu` (the load-bearing gate against a
//! guest TDR-resetting the shared GPU for every other app). `within_budget()` is
//! asserted before every submit as the cooperative guest's own check; the host is
//! authoritative regardless.
//!
//! Control flow mirrors canvas-present-guest (see docs/rill-canvas.zh.md §6):
//!   host rAF → onFrame subscription → wake the executor → guest_main submits a
//!   frame. A `gpu.deviceLost` subscription flags a re-init so a driver TDR (from
//!   this app OR another app on the shared GPU) is recovered rather than fatal.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};

use alloc::vec::Vec;
use rill_guest::events;
use rill_guest::gpu::{self, CommandBuffer, Handle, Mode};

rill_guest::rill_guest_main!(guest_main);

/// The `<Canvas canvasId="viewport" />` the host app mounts for this guest.
const CANVAS_ID: &str = "viewport";
/// Fixed viewport size (device px) used for the fill-rate estimate + SET_VIEWPORT.
const W: f32 = 512.0;
const H: f32 = 512.0;

// Frame gate (same pattern as canvas-present-guest): the "canvas.frame" handler
// bumps FRAME + sets READY then wakes the executor; NextFrame consumes READY in
// the async loop. Single-threaded wasm, so plain statics are sound.
static mut FRAME: u32 = 0;
static mut READY: bool = false;
// Set by the gpu.deviceLost handler; guest_main re-configures + re-uploads on it.
static mut DEVICE_LOST: bool = false;

/// Resolves once the next `canvas.frame` tick has been signalled.
struct NextFrame;
impl Future for NextFrame {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        unsafe {
            if READY {
                READY = false;
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        }
    }
}

/// One interleaved `[x, y, r, g, b, a]` (f32) vertex for the `SOLID_2D` preset.
fn vertex(out: &mut Vec<u8>, x: f32, y: f32, r: f32, g: f32, b: f32, a: f32) {
    for v in [x, y, r, g, b, a] {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

/// Build the demo triangle's vertex bytes once (clip-space positions + per-vertex
/// color). The host `SOLID_2D` preset consumes this layout; no guest shader.
fn triangle_bytes() -> Vec<u8> {
    let mut v = Vec::new();
    vertex(&mut v, 0.0, 0.6, 1.0, 0.2, 0.2, 1.0); // top    (red)
    vertex(&mut v, -0.6, -0.5, 0.2, 1.0, 0.2, 1.0); // left   (green)
    vertex(&mut v, 0.6, -0.5, 0.2, 0.4, 1.0, 1.0); // right  (blue)
    v
}

async fn guest_main() {
    // Per-frame render clock.
    events::on("canvas.frame", |_p: &[u8]| unsafe {
        FRAME = FRAME.wrapping_add(1);
        READY = true;
        rill_guest::rt::wake();
    });
    // Shared-GPU TDR / context-loss recovery: a lost device may be caused by
    // ANOTHER app on the same GPU, so flag a full re-init rather than treating it
    // as fatal. The host emits this like a frame tick; the handler must not .await.
    gpu::on_device_lost(|_p: &[u8]| unsafe {
        DEVICE_LOST = true;
        rill_guest::rt::wake();
    });

    // Mount the viewport in WEBGPU mode so the host locks the <canvas> to a webgpu
    // context (mode is fixed at mount; host:gpu.configure(Webgpu) then matches it).
    let kids = alloc::vec![rill_guest::ui::canvas_mode(
        CANVAS_ID, W as u32, H as u32, "webgpu"
    )];
    rill_guest::render(rill_guest::ui::view(kids));

    // Build the vertex bytes ONCE (BumpAlloc only grows). Kept alive for the
    // guest's life so the handle's backing upload is stable.
    let verts = triangle_bytes();

    // Configure + upload LAZILY on the first frame. The <Canvas> host component
    // registers its handle in a mount effect that runs AFTER this guest's initial
    // render batch is delivered — configuring here (pre-frame) would race ahead of
    // the handle and fail closed. onFrame only fires once the canvas is mounted, so
    // the handle is guaranteed to exist by the time we configure below.
    let mut vbuf: Option<Handle> = None;

    loop {
        NextFrame.await;

        // (Re)initialize on the first frame, and again after a lost device (TDR/loss).
        if unsafe { core::mem::replace(&mut DEVICE_LOST, false) } {
            vbuf = None;
        }
        if vbuf.is_none() {
            vbuf = configure_and_upload(&verts).await;
        }
        let Some(handle) = vbuf else {
            // gpu unavailable / re-init failed: skip this frame, retry next tick.
            continue;
        };

        let phase = unsafe { FRAME };
        // Animate only the clear color (a host-preset pipeline draws the triangle);
        // no guest shader, no per-pixel guest code on the GPU.
        let t = ((phase & 0xff) as f32) / 255.0;

        let mut cmds = CommandBuffer::new();
        cmds.begin_pass(0.03, 0.03 + 0.1 * t, 0.08, 1.0)
            .set_viewport(0.0, 0.0, W, H)
            .set_pipeline(gpu::preset::SOLID_2D)
            .set_vertex(handle)
            .draw(3)
            .end_pass()
            .finish();

        // Cooperative self-check: this tiny buffer is far under budget. (The host
        // re-validates + enforces the budget regardless — this is not the gate.)
        debug_assert!(cmds.within_budget());

        // Fails closed (Err) if the host lacks gpu wiring or the device is lost; we
        // ignore the outcome and wait for the next tick, so a host without gpu never
        // turns this into a busy loop.
        let _ = gpu::submit(CANVAS_ID, &cmds).await;
    }
}

/// Configure the canvas for webgpu (falling back to webgl2) and upload the vertex
/// buffer. Returns the vertex-buffer handle, or `None` if no gpu backend is
/// available (both configures failed) — the caller then skips frames.
async fn configure_and_upload(verts: &[u8]) -> Option<Handle> {
    let ok = gpu::configure(CANVAS_ID, Mode::Webgpu).await
        || gpu::configure(CANVAS_ID, Mode::Webgl2).await;
    if !ok {
        return None;
    }
    gpu::create_vertex_buffer(CANVAS_ID, verts).await
}
