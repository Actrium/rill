//! Adversarial native rill guest: on init it allocates far beyond the SDK's
//! 1 MiB bump heap, so the allocation fails and the guest aborts (a WASM trap).
//! The host must surface that as a catchable error (load() rejects) and keep
//! running — a heap-exhausted guest must not crash the host process.
#![no_std]

extern crate alloc;

use alloc::vec::Vec;

rill_guest::rill_guest_main!(guest_main);

async fn guest_main() {
    // > 1 MiB heap -> bump allocator returns null -> handle_alloc_error -> trap.
    let v: Vec<u8> = Vec::with_capacity(2_000_000);
    core::hint::black_box(v.as_ptr());
}
