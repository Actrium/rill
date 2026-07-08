#!/usr/bin/env bash
# Build the native Rust guest(s) to wasm and stage them as test fixtures.
#
# RUSTFLAGS is cleared to override a global `-fuse-ld=mold` (mold can't link the
# wasm target; rust-lld rejects the flag). Needs: rustup target add wasm32-unknown-unknown.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
FIXTURES=../src/host/wasm-guest/__tests__/fixtures
GUESTS="kv-guest ui-guest seq-guest event-guest heap-exhaust-guest canvas-guest canvas-present-guest canvas-gpu-guest canvas-escape-guest asset-guest"

# Optional debug build: DWARF-carrying guests for source-level debugging inside
# V8's wasm debugger (Chrome DevTools "C/C++ DevTools Support (DWARF)"). Output
# goes to a SEPARATE dir and NEVER overwrites the shipped, DWARF-free release
# fixtures; real source paths are preserved (no --remap-path-prefix here). See
# docs/native-guest-debugging.zh.md.
if [ "${RILL_GUEST_DEBUG:-}" = "1" ]; then
  DEBUG_OUT=debug-artifacts
  mkdir -p "$DEBUG_OUT"
  # shellcheck disable=SC2086
  RUSTFLAGS=" " cargo build $(printf -- '-p %s ' $GUESTS) --target "$TARGET" --profile debug-wasm
  for lib in $GUESTS; do
    crate="${lib//-/_}"
    cp "target/$TARGET/debug-wasm/$crate.wasm" "$DEBUG_OUT/$lib.wasm"
    echo "debug (DWARF): $DEBUG_OUT/$lib.wasm ($(wc -c < "$DEBUG_OUT/$lib.wasm") bytes)"
  done
  echo "NOTE: debug guests carry DWARF + real source paths; do NOT commit them."
  exit 0
fi

RUSTFLAGS=" " cargo build -p kv-guest -p ui-guest -p seq-guest -p event-guest -p heap-exhaust-guest -p canvas-guest -p canvas-present-guest -p canvas-gpu-guest -p canvas-escape-guest -p asset-guest --target "$TARGET" --release

stage() { # <crate-lib-name> <fixture-name>
  cp "target/$TARGET/release/$1.wasm" "$FIXTURES/$2"
  echo "staged: $FIXTURES/$2 ($(wc -c < "$FIXTURES/$2") bytes)"
}
stage kv_guest kv-guest.wasm
stage seq_guest seq-guest.wasm
stage ui_guest ui-guest.wasm
stage event_guest event-guest.wasm
stage heap_exhaust_guest heap-exhaust-guest.wasm
stage canvas_guest canvas-guest.wasm
stage canvas_present_guest canvas-present-guest.wasm
stage canvas_gpu_guest canvas-gpu-guest.wasm
stage canvas_escape_guest canvas-escape-guest.wasm
stage asset_guest asset-guest.wasm
