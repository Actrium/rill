#!/usr/bin/env bash
# Build the native Rust guest(s) to wasm and stage them as test fixtures.
#
# RUSTFLAGS overrides a global `-fuse-ld=mold` (mold can't link the wasm target;
# rust-lld rejects the flag). Needs: rustup target add wasm32-unknown-unknown.
#
# --remap-path-prefix keeps build-machine absolute paths out of the .wasm
# (panic Location strings would otherwise embed them), so fixtures are
# byte-reproducible across checkouts.
#
# CARGO_TARGET_DIR is dedicated: plain `cargo test`/`cargo clippy` runs (no
# remap flag) share the default target/ and cargo may reuse their artifacts
# without honoring the RUSTFLAGS change — which silently re-embeds absolute
# paths. An isolated target dir makes the remap unconditional.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
FIXTURES=../src/host/wasm-guest/__tests__/fixtures
export CARGO_TARGET_DIR=target/fixtures

RUSTFLAGS="--remap-path-prefix=$(pwd)=." cargo build -p kv-guest -p ui-guest -p seq-guest -p event-guest -p heap-churn-guest -p canvas-guest -p canvas-present-guest -p canvas-gpu-guest -p canvas-escape-guest -p asset-guest --target "$TARGET" --release

# canvas-binary-guest is built in a SEPARATE cargo invocation on purpose: it
# turns ON rill-guest's `wip-binary-protocol` feature, and cargo unifies features
# across all packages in a single build. Building it apart keeps the WIP feature
# out of the default JSON fixtures above (their rill-guest stays feature-clean),
# so the DEFAULT shipped guests provably still emit JSON.
RUSTFLAGS="--remap-path-prefix=$(pwd)=." cargo build -p canvas-binary-guest --target "$TARGET" --release

stage() { # <crate-lib-name> <fixture-name>
  cp "$CARGO_TARGET_DIR/$TARGET/release/$1.wasm" "$FIXTURES/$2"
  echo "staged: $FIXTURES/$2 ($(wc -c < "$FIXTURES/$2") bytes)"
}
stage kv_guest kv-guest.wasm
stage seq_guest seq-guest.wasm
stage ui_guest ui-guest.wasm
stage event_guest event-guest.wasm
stage heap_churn_guest heap-churn-guest.wasm
stage canvas_guest canvas-guest.wasm
stage canvas_binary_guest canvas-binary-guest.wasm
stage canvas_present_guest canvas-present-guest.wasm
stage canvas_gpu_guest canvas-gpu-guest.wasm
stage canvas_escape_guest canvas-escape-guest.wasm
stage asset_guest asset-guest.wasm
