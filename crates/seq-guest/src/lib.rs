//! Demo native rill guest that makes TWO sequential host awaits (put then get)
//! and uses a value with a quote + backslash to exercise JSON escaping in both
//! directions. Stresses the SDK's single-task executor: the second `.await`
//! only resolves after the host's second `rill_resolve` re-polls the task, and
//! results must be matched to the right call by `cb_id`.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;

rill_guest::rill_guest_main!(guest_main);

// A value with characters that must be JSON-escaped: b " \ c
const TRICKY: &str = "b\"\\c";

static mut STEP: i32 = 0; // how far the sequential chain progressed
static mut GOT: Vec<u8> = Vec::new(); // the get() response body

async fn guest_main() {
    if rill_guest::store::put("a", TRICKY).await.is_err() {
        return;
    }
    unsafe { STEP = 1 };
    if let Ok(bytes) = rill_guest::store::get("a").await {
        unsafe {
            STEP = 2;
            GOT = bytes;
        }
    }
}

#[no_mangle]
pub extern "C" fn step() -> i32 {
    unsafe { STEP }
}

#[no_mangle]
pub extern "C" fn got_ptr() -> *const u8 {
    unsafe { GOT.as_ptr() }
}

#[no_mangle]
pub extern "C" fn got_len() -> usize {
    unsafe { GOT.len() }
}
