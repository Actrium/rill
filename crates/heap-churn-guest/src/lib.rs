//! Native rill guest that stress-tests the guest heap allocator (talc).
//!
//! Historically this fixture over-allocated past the SDK's fixed 1 MiB bump
//! heap so the allocation failed and the guest trapped — a resilience probe for
//! the host. That premise is gone: the guest allocator is now talc, backed by
//! `memory.grow`, so it GROWS to fit the working set (no 1 MiB cliff) and keeps
//! a real free list (freed blocks are reused, in any order).
//!
//! The fixture now proves that new contract. The `heap_churn` export drives a
//! long alloc/free churn whose CUMULATIVE allocation dwarfs the old 1 MiB cap
//! (megabytes across hundreds of frames) while holding only a small sliding
//! window of buffers live at once. A leaking or grow-only allocator would push
//! linear memory up without bound; talc reclaims each freed frame, so the host
//! observes `memory.buffer.byteLength` grow during warm-up and then PLATEAU.
//!
//! Freeing is FIFO (oldest buffer first) — deliberately NOT the LIFO order a
//! bump allocator needs — so a successful plateau also proves out-of-order
//! reclamation, the interleaved-lifetime case the old bump heap could not serve.
#![no_std]

extern crate alloc;

use alloc::collections::VecDeque;
use alloc::vec::Vec;

rill_guest::rill_guest_main!(guest_main);

async fn guest_main() {
    // No lifecycle behaviour; this fixture exists for the `heap_churn` hook the
    // host test calls directly. rill_init still runs so the guest loads cleanly.
}

/// Test hook: run `frames` alloc/free frames, each allocating `bytes_per_frame`
/// and retaining at most `live_window` buffers at once (older buffers are freed
/// FIFO). Returns a checksum so the optimizer cannot elide the work.
///
/// Cumulative bytes allocated = `frames * bytes_per_frame` (intended to far
/// exceed the old 1 MiB cap); peak live bytes = `live_window * bytes_per_frame`
/// (kept small so a correct allocator plateaus). `live_window` of 1 degenerates
/// to the pure "allocate then free before the next frame" pattern.
#[no_mangle]
pub extern "C" fn heap_churn(frames: u32, bytes_per_frame: u32, live_window: u32) -> u32 {
    let window = live_window.max(1);
    let size = bytes_per_frame as usize;
    let mut live: VecDeque<Vec<u8>> = VecDeque::new();
    let mut acc: u32 = 0;

    for i in 0..frames {
        // A fresh heap allocation, written through so it maps real pages.
        let mut buf: Vec<u8> = alloc::vec![(i & 0xff) as u8; size];
        if let Some(first) = buf.first_mut() {
            *first ^= 0x5a;
        }
        acc = acc
            .wrapping_add(buf[0] as u32)
            .wrapping_add(buf[size.saturating_sub(1)] as u32);
        core::hint::black_box(buf.as_ptr());
        live.push_back(buf);

        // Free the OLDEST buffers first (FIFO -> non-LIFO reclamation).
        while live.len() as u32 > window {
            let old = live.pop_front().unwrap();
            acc = acc.wrapping_add(old.len() as u32);
            drop(old);
        }
    }
    // Drain the remaining window so nothing leaks across calls.
    while let Some(old) = live.pop_front() {
        acc = acc.wrapping_add(old.len() as u32);
    }
    acc
}
