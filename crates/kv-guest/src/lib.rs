//! Demo native (non-JS) rill guest, written in Rust against the `rill-guest`
//! SDK. It calls `host:kv.put("a", "b")` and stashes the outcome behind exports
//! the test reads. The whole thing compiles to a `.wasm` the Phase A
//! `WasmGuestHost` loads unchanged — proving the ergonomic SDK path end to end.
#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;

rill_guest::rill_guest_main!(guest_main);

static mut OK: i32 = -1;
static mut RESULT: Vec<u8> = Vec::new();

async fn guest_main() {
    match rill_guest::store::put("a", "b").await {
        Ok(bytes) => unsafe {
            OK = 1;
            RESULT = bytes;
        },
        Err(bytes) => unsafe {
            OK = 0;
            RESULT = bytes;
        },
    }
}

#[no_mangle]
pub extern "C" fn last_ok() -> i32 {
    unsafe { OK }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    unsafe { RESULT.as_ptr() }
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { RESULT.len() }
}
