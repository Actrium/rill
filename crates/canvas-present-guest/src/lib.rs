//! Demo native (non-JS) rill guest for the stage ② framebuffer path.
//!
//! It SOFTWARE-RENDERS an animated scene — a scrolling RGBA gradient with a
//! bouncing white box — directly into its OWN linear memory (a `Surface`), then
//! hands each frame to `host:canvas.present`. The host reads those pixels back
//! (bounds-checked, slice-COPY) and `putImageData`s them onto the real `<Canvas>`.
//! Pixels never enter JSON and never leave the iframe — the seal's core external
//! surface (third-party egress) is untouched; a same-origin blit is "more inner"
//! than any network path.
//!
//! Control flow (see docs/rill-canvas.zh.md, the input + frame-loop section):
//!   host rAF -> onFrame subscription -> emitEvent("canvas.frame") -> our handler
//!   -> wake the executor -> guest_main renders + `present(...).await`.
//!
//! Why a `wake()`: an event handler is SYNCHRONOUS (it cannot `.await`) and does
//! NOT re-poll the async task. So the handler only bumps the frame counter, flips
//! a "frame ready" flag, and calls `rill_guest::rt::wake()`; the awaited render +
//! present loop lives in `guest_main`. A frame that arrives while the previous
//! `present` is still in flight simply coalesces (the flag stays set), which is
//! exactly the "at most one frame in flight" backpressure the host also enforces.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};

use rill_guest::canvas::{self, Surface};
use rill_guest::events;

rill_guest::rill_guest_main!(guest_main);

/// The `<Canvas canvasId="viewport" />` the host app mounts for this guest.
const CANVAS_ID: &str = "viewport";
/// Fixed framebuffer size. A real guest would size this from `host:canvas.getInfo`
/// / the `canvas.resize` event (device pixels); a fixture keeps it constant so the
/// host test can mount a matching backing store (present is 1:1 device px).
const W: u32 = 128;
const H: u32 = 128;

// Frame gate: the "canvas.frame" handler bumps FRAME + sets READY, then wakes the
// executor; NextFrame (below) consumes READY inside the async loop. Single-thread
// wasm, so plain statics are sound (no real concurrency).
static mut FRAME: u32 = 0;
static mut READY: bool = false;

/// A future that resolves once the next `canvas.frame` event has been signalled.
/// Parks (Poll::Pending) until the handler sets `READY` and calls `rt::wake()`.
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

async fn guest_main() {
    // Subscribe to the host's per-frame tick. The payload carries {t, dt, frame};
    // we drive animation off a local monotonic counter (robust with no JSON parse
    // in no_std), and use the event purely as the render clock.
    events::on("canvas.frame", |_payload: &[u8]| unsafe {
        FRAME = FRAME.wrapping_add(1);
        READY = true;
        rill_guest::rt::wake();
    });

    // Mount the viewport: emit a <Canvas> so the host creates + registers the real
    // <canvas> that present() targets. One-shot descriptive-UI batch (here the whole
    // UI is the canvas; a real app nests it under View/Text chrome). Note the local
    // `render` fn below is the SOFTWARE renderer — the UI batch is rill_guest::render.
    let kids = alloc::vec![rill_guest::ui::canvas(CANVAS_ID, W, H)];
    rill_guest::render(rill_guest::ui::view(kids));

    // Allocate the framebuffer ONCE and reuse it every frame (BumpAlloc only
    // grows — a per-frame Surface would leak for the guest's life).
    let mut surface = Surface::new(W, H);

    loop {
        // Park until the next frame tick, then render + hand the pixels to the host.
        NextFrame.await;
        let phase = unsafe { FRAME };
        render(surface.pixels_mut(), W, H, phase);
        // `present` parks until the host has finished reading our bytes; its ack is
        // the backpressure signal. It fails closed (Err) if the host has no present
        // wiring — we ignore the outcome and wait for the next frame either way, so
        // a host without present never turns this into a busy loop.
        let _ = canvas::present(CANVAS_ID, &surface).await;
    }
}

/// Software-render one animated frame of straight-alpha RGBA8 into `px`.
/// A diagonally scrolling gradient (background) plus a box bouncing on both axes.
fn render(px: &mut [u8], w: u32, h: u32, phase: u32) {
    let wi = w as i32;
    let hi = h as i32;
    let ph = (phase as i32) & 0x3ff; // bound the phase so arithmetic stays small

    // Background: scrolling gradient. Each channel is a cheap function of the pixel
    // position offset by the frame phase, giving a moving diagonal wash.
    for y in 0..hi {
        for x in 0..wi {
            let i = ((y * wi + x) * 4) as usize;
            px[i] = ((x + ph) & 0xff) as u8; // R
            px[i + 1] = ((y + ph) & 0xff) as u8; // G
            px[i + 2] = (((x + y) / 2 + ph) & 0xff) as u8; // B
            px[i + 3] = 0xff; // A (straight-alpha, fully opaque)
        }
    }

    // Foreground: a white box bouncing via triangle waves on x and y (different
    // rates so it traces a Lissajous-ish path rather than a straight diagonal).
    let bw = 24i32;
    let bh = 24i32;
    let bx = triangle(ph, (wi - bw).max(1));
    let by = triangle(ph * 3 / 2, (hi - bh).max(1));
    for y in by..(by + bh).min(hi) {
        for x in bx..(bx + bw).min(wi) {
            let i = ((y * wi + x) * 4) as usize;
            px[i] = 0xff;
            px[i + 1] = 0xff;
            px[i + 2] = 0xff;
            px[i + 3] = 0xff;
        }
    }
}

/// Triangle wave in `[0, span]`: ramps up then down, period `2*span`. Keeps a
/// bouncing coordinate inside the surface without any float / trig.
fn triangle(t: i32, span: i32) -> i32 {
    let period = 2 * span;
    let p = t.rem_euclid(period);
    if p < span {
        p
    } else {
        period - p
    }
}
