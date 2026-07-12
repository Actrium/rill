//! Test-fixture native (non-JS) rill guest that exercises the WIP binary
//! OP-BATCH wire end-to-end via the `rill_wire_caps` runtime gate.
//!
//! Built with `rill-guest`'s `wip-binary-protocol` feature ON, so the SDK
//! exports `rill_wire_caps`:
//!   - a host that pushes bit0 (binaryOpBatch on) BEFORE `rill_init` receives
//!     the render batch as a binary `RILL` frame;
//!   - any other host (old host, option off) never calls the export, the gate
//!     stays false, and the guest transparently emits the legacy JSON batch —
//!     the graceful-degrade path.
//!
//! The tree is the SAME deterministic one `ui-guest` renders, so a host
//! round-trip test can assert the decoded `OperationBatch` equals the JSON
//! guest's byte-for-byte in op terms. It deliberately repeats node types
//! (`View`, `__TEXT__`) so the wire's intern table is exercised (one entry,
//! multiple refs).
#![no_std]

extern crate alloc;

use rill_guest::ui::{text, view};

rill_guest::rill_guest_main!(guest_main);

async fn guest_main() {
    rill_guest::render(view(alloc::vec![
        text("hello from rust"),
        view(alloc::vec![text("nested")]),
    ]));
}
