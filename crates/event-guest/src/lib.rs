//! Demo native rill guest that receives host->guest events. It registers a
//! handler for the "ping" event; each delivery bumps a counter and stashes the
//! payload behind exports the test reads — proving input/lifecycle events reach
//! a native guest (it is no longer render-only).
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;

rill_guest::rill_guest_main!(guest_main);

static mut COUNT: i32 = 0;
static mut LAST: Vec<u8> = Vec::new();
static mut ONCE_ID: u32 = 0;
static mut ONCE_COUNT: i32 = 0;

async fn guest_main() {
    rill_guest::events::on("ping", |payload: &[u8]| unsafe {
        COUNT += 1;
        LAST = payload.to_vec();
    });
    // A one-shot handler that removes ITSELF during dispatch — exercises the
    // "mutate HANDLERS while dispatching" path (must be sound, not UAF).
    unsafe {
        ONCE_ID = rill_guest::events::on("once", |_| {
            ONCE_COUNT += 1;
            rill_guest::events::off(ONCE_ID);
        });
    }
}

#[no_mangle]
pub extern "C" fn once_count() -> i32 {
    unsafe { ONCE_COUNT }
}

#[no_mangle]
pub extern "C" fn count() -> i32 {
    unsafe { COUNT }
}

#[no_mangle]
pub extern "C" fn last_ptr() -> *const u8 {
    unsafe { LAST.as_ptr() }
}

#[no_mangle]
pub extern "C" fn last_len() -> usize {
    unsafe { LAST.len() }
}
