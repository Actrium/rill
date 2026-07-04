#!/usr/bin/env bash
# Build the C example guest to wasm and stage it as a test fixture.
#
# Two-step (compile then link) so a clang/wasm-ld version mismatch doesn't matter:
# clang -c emits a wasm object; wasm-ld links it. Needs clang (wasm32 target) and
# an LLVM wasm-ld. Override the linker with WASM_LD=/path/to/wasm-ld if needed.
set -euo pipefail
cd "$(dirname "$0")"

WASM_LD="${WASM_LD:-$(command -v wasm-ld || echo /usr/lib/llvm-17/bin/wasm-ld)}"
FIXTURE=../../src/host/wasm-guest/__tests__/fixtures/c-guest.wasm

clang --target=wasm32-unknown-unknown -nostdlib -O2 -c example-guest.c -o example-guest.o
"$WASM_LD" --no-entry --allow-undefined --export-memory --export=rill_init \
  example-guest.o -o "$FIXTURE"
rm -f example-guest.o

echo "staged: $FIXTURE ($(wc -c < "$FIXTURE") bytes)"
