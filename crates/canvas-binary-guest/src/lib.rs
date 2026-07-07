//! Test-fixture native (non-JS) rill guest that exercises the WIP binary CANVAS
//! wire end-to-end via the capability handshake.
//!
//! Built with `rill-guest`'s `wip-binary-protocol` feature ON, so `canvas::draw`
//! first probes `host:canvas.getInfo` (see `canvas-wire.DESIGN.md` §1):
//!   - a host that advertises `binaryDraw:true` for the encoder's `wireVersion`
//!     receives the binary `RCNV` frame;
//!   - any other host (no `getInfo`, or `binaryDraw:false`) transparently
//!     receives the legacy JSON op-list — the graceful-degrade path.
//!
//! The scene is small and DETERMINISTIC so a host round-trip test can assert the
//! decoded op array exactly. It deliberately REPEATS a color (`#ff0000`) so the
//! binary frame's per-frame intern table is exercised (one entry, two refs).
#![no_std]

extern crate alloc;

use rill_guest::canvas::{self, DrawList};

rill_guest::rill_guest_main!(guest_main);

/// The `<Canvas canvasId="scene" />` the host app mounts for this guest.
const CANVAS_ID: &str = "scene";

async fn guest_main() {
    let mut dl = DrawList::new();

    // A red bar (color #1).
    dl.set_fill_style("#ff0000");
    dl.fill_rect(0.0, 0.0, 100.0, 50.0);

    // A red dot — REPEATS #ff0000 so the intern table reuses the same ref.
    dl.set_fill_style("#ff0000");
    dl.begin_path();
    dl.arc(50.0, 25.0, 10.0, 0.0, 6.28); // ccw=false (SDK fixes this)
    dl.fill();

    // A multibyte label (inline text, not interned).
    dl.set_fill_style("#00ff00");
    dl.fill_text("hi ☕", 4.0, 20.0);

    let _ = canvas::draw(CANVAS_ID, &dl).await;
}
