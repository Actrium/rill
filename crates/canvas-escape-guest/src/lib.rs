//! Native (non-JS) rill guest that exercises the canvas SDK's guest->host JSON
//! ESCAPING. It draws a one-op display list whose `canvasId`, fill color and text
//! all carry JSON metacharacters (quote, backslash, newline, tab) plus multi-byte
//! UTF-8 (`é`, an emoji). The host decodes the batch with a strict `JSON.parse`,
//! so if the SDK mis-escaped any byte the call would fail closed (ok=0) and the
//! recorded draw would be absent; a recorded draw whose strings match EXACTLY
//! proves the escaping round-trips.
#![no_std]

extern crate alloc;

use rill_guest::canvas::{self, DrawList};

rill_guest::rill_guest_main!(guest_main);

/// A canvasId carrying a quote, backslash, newline and tab — all of which the SDK
/// must escape for the host's `JSON.parse` to recover the byte-exact string.
const CANVAS_ID: &str = "scene\"\\\n\tid";
/// A CSS color string with an embedded quote + backslash (still a valid string).
const COLOR: &str = "#ff0000\"\\";
/// Text mixing metacharacters with multi-byte UTF-8 (2-byte `é`, 4-byte emoji).
const TEXT: &str = "hé\"llo\\\n\t😀";

async fn guest_main() {
    let mut dl = DrawList::new();
    dl.set_fill_style(COLOR);
    dl.fill_rect(0.0, 0.0, 10.0, 10.0);
    dl.fill_text(TEXT, 1.0, 2.0);
    let _ = canvas::draw(CANVAS_ID, &dl).await;
}
