#!/usr/bin/env bash
# Build the native Rust guest(s) to wasm and stage them as test fixtures.
#
# RUSTFLAGS is cleared to override a global `-fuse-ld=mold` (mold can't link the
# wasm target; rust-lld rejects the flag). Needs: rustup target add wasm32-unknown-unknown.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
FIXTURES=../src/host/wasm-guest/__tests__/fixtures

RUSTFLAGS=" " cargo build -p kv-guest -p ui-guest --target "$TARGET" --release

stage() { # <crate-lib-name> <fixture-name>
  cp "target/$TARGET/release/$1.wasm" "$FIXTURES/$2"
  echo "staged: $FIXTURES/$2 ($(wc -c < "$FIXTURES/$2") bytes)"
}
stage kv_guest kv-guest.wasm
stage ui_guest ui-guest.wasm
