//! Demo native (non-JS) rill guest for the ④ `host:asset` path.
//!
//! On init it resolves an app-package asset to decoded RGBA entirely inside its
//! OWN linear memory, using the `rill_guest::asset` SDK:
//!   1. `asset::info("logo")`  -> the decoded `(w, h)`,
//!   2. allocate a `w×h` RGBA8 `Surface` (guest memory),
//!   3. `asset::blit("logo", ptr, cap)` -> the host WRITES the decoded pixels
//!      straight into that buffer (bounds-checked host-side).
//! The guest never fetches or decodes anything — the host owns resolution +
//! decode; the guest only hands it a buffer to fill. Pixels never enter JSON.
//!
//! Fail-closed: if `info` returns no dimensions (unknown/undecodable id) the
//! guest simply records nothing and does NOT call `blit` — it never crashes.
//!
//! The exports (`loaded`, `written`, `buf_ptr`, `width`, `height`) let the host
//! test read back what landed: it can slice-copy guest memory at `buf_ptr` and
//! assert the host's blit bytes actually arrived.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use rill_guest::asset;
use rill_guest::canvas::Surface;

rill_guest::rill_guest_main!(guest_main);

/// The app-package asset id this guest resolves. The host test's `host:asset`
/// dispatch keys off this exact id.
const ASSET_ID: &str = "logo";

// Outcome state, exposed via exports below (single-thread wasm -> plain statics).
static mut LOADED: i32 = 0;
static mut WRITTEN: u32 = 0;
static mut WIDTH: u32 = 0;
static mut HEIGHT: u32 = 0;
// Hold the resolved surface for the guest's life so its buffer stays mapped and
// the test can read the blitted bytes back at `buf_ptr` (BumpAlloc never frees,
// but keeping it owned makes the intent explicit — a real guest composites it).
static mut SURFACE: Option<Surface> = None;

async fn guest_main() {
    // Step 1: ask the host for the asset's decoded dimensions. `None` on an
    // unknown / undecodable id -> fail-closed (we stop here, never blit).
    let Some((w, h)) = asset::info(ASSET_ID).await else {
        return;
    };
    unsafe {
        WIDTH = w;
        HEIGHT = h;
    }

    // Step 2: allocate the guest-owned RGBA8 buffer the host will fill.
    let surface = Surface::new(w, h);
    let ptr = surface.ptr();
    let cap = surface.pixels().len();

    // Step 3: hand the host the buffer to blit the decoded pixels into. The
    // host writes `w*h*4` bytes at `ptr` (bounds-checked) and returns the count.
    let Some(written) = asset::blit(ASSET_ID, ptr, cap).await else {
        return;
    };

    unsafe {
        SURFACE = Some(surface);
        WRITTEN = written as u32;
        LOADED = 1;
    }
}

/// 1 once info + blit both succeeded and the buffer is filled; 0 otherwise.
#[no_mangle]
pub extern "C" fn loaded() -> i32 {
    unsafe { LOADED }
}

/// Bytes the host reported writing during blit (expected `w*h*4`).
#[no_mangle]
pub extern "C" fn written() -> u32 {
    unsafe { WRITTEN }
}

/// Linear-memory offset of the RGBA8 buffer the host blitted into.
#[no_mangle]
pub extern "C" fn buf_ptr() -> *const u8 {
    unsafe {
        match &SURFACE {
            Some(s) => s.pixels().as_ptr(),
            None => core::ptr::null(),
        }
    }
}

/// Decoded asset width reported by `host:asset.info`.
#[no_mangle]
pub extern "C" fn width() -> u32 {
    unsafe { WIDTH }
}

/// Decoded asset height reported by `host:asset.info`.
#[no_mangle]
pub extern "C" fn height() -> u32 {
    unsafe { HEIGHT }
}
