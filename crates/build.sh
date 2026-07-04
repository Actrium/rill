#!/usr/bin/env bash
# Build the native Rust guest(s) to wasm and stage them as test fixtures.
#
# RUSTFLAGS is cleared to override a global `-fuse-ld=mold` (mold can't link the
# wasm target; rust-lld rejects the flag). Needs: rustup target add wasm32-unknown-unknown.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
FIXTURES=../src/host/wasm-guest/__tests__/fixtures

RUSTFLAGS=" " cargo build -p kv-guest --target "$TARGET" --release

cp "target/$TARGET/release/kv_guest.wasm" "$FIXTURES/kv-guest.wasm"
echo "staged: $FIXTURES/kv-guest.wasm ($(wc -c < "$FIXTURES/kv-guest.wasm") bytes)"
