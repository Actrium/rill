//! Demo native (non-JS) rill guest that draws a recognizable 2D scene — a house
//! under a sun — with the `rill-guest` `canvas` SDK. It builds a `DrawList` and
//! hands it to `host:canvas.draw`, which the host validates op-by-op and replays
//! onto the real `<Canvas>` 2D context (stage ①). Compiles to a `.wasm` the
//! `WasmGuestHost` loads unchanged — the first native guest to produce graphics.
//!
//! It also constructs a `Surface` (stage ② framebuffer path) to exercise that
//! SDK shape at compile time; it does not `present().await` because the host side
//! of `present` lands in stage ② and would otherwise park forever.
#![no_std]

extern crate alloc;

use rill_guest::canvas::{self, DrawList, Surface};

rill_guest::rill_guest_main!(guest_main);

/// The `<Canvas canvasId="scene" />` the host app mounts for this guest.
const CANVAS_ID: &str = "scene";

async fn guest_main() {
    let mut dl = DrawList::new();

    // Sky.
    dl.set_fill_style("#8ec7ff");
    dl.fill_rect(0.0, 0.0, 320.0, 240.0);

    // Sun (filled circle).
    dl.set_fill_style("#ffd23f");
    dl.begin_path();
    dl.arc(262.0, 58.0, 30.0, 0.0, core::f64::consts::TAU);
    dl.fill();

    // Ground.
    dl.set_fill_style("#4caf50");
    dl.fill_rect(0.0, 190.0, 320.0, 50.0);

    // House body.
    dl.set_fill_style("#c96f4a");
    dl.fill_rect(90.0, 120.0, 120.0, 80.0);

    // Roof (triangle via a closed path).
    dl.set_fill_style("#7a3b2e");
    dl.begin_path();
    dl.move_to(78.0, 120.0);
    dl.line_to(150.0, 68.0);
    dl.line_to(222.0, 120.0);
    dl.close_path();
    dl.fill();

    // Door.
    dl.set_fill_style("#3e2723");
    dl.fill_rect(133.0, 154.0, 34.0, 46.0);

    // House outline.
    dl.set_stroke_style("#222222");
    dl.set_line_width(2.0);
    dl.stroke_rect(90.0, 120.0, 120.0, 80.0);

    // Label.
    dl.set_fill_style("#ffffff");
    dl.fill_text("rill", 12.0, 30.0);

    let _ = canvas::draw(CANVAS_ID, &dl).await;

    // Stage ② shape check: allocate a framebuffer and paint one pixel band. We do
    // NOT present().await here (host `present` wiring is stage ②).
    let mut surf = Surface::new(64, 64);
    let px = surf.pixels_mut();
    for chunk in px.chunks_exact_mut(4) {
        chunk[0] = 0xff; // R
        chunk[3] = 0xff; // A (straight-alpha)
    }
    core::hint::black_box(surf.ptr());
}
