#!/usr/bin/env bash
# ============================================================================
# fuzz-wire-differential.sh — one-shot differential fuzz of the op-batch wire
# protocol decoders (NEW; opt-in; not part of the normal test run).
#
#   1. builds the C++ fuzz driver under AddressSanitizer + UBSan;
#   2. runs it: generates a byte-identical corpus + the C++ result stream, and
#      (under ASan) proves the C++ decoder never crashes / reads OOB / hits UB;
#   3. runs the TS decoder over the SAME corpus with bun and diffs the two
#      result streams (accept/reject agreement + decoded-value agreement).
#
# Exit nonzero if ASan aborts, the TS decoder throws a non-typed error, or the
# two decoders diverge on any input.
#
# Usage:  scripts/fuzz-wire-differential.sh [ITERATIONS] [SEED]
# ============================================================================
set -euo pipefail

ITER="${1:-100000}"
SEED="${2:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$REPO_ROOT/native/core/test"
BUILD_DIR="$TEST_DIR/build_fuzz"
CORPUS="$BUILD_DIR/fuzz_corpus.bin"
RESULTS="$BUILD_DIR/fuzz_cpp.results"

echo "=============================================="
echo "  WireDecoder differential fuzz"
echo "  iterations=$ITER seed=$SEED"
echo "=============================================="

echo ""
echo "[1/3] Building C++ fuzz driver (ASan + UBSan)..."
make -C "$TEST_DIR" -f fuzz.mk >/dev/null

echo "[2/3] Generating corpus + decoding on the C++ side..."
# abort_on_error makes any ASan/UBSan finding kill the process (nonzero exit).
ASAN_OPTIONS=abort_on_error=1:detect_leaks=0 \
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 \
  "$BUILD_DIR/fuzz_wire_decoder" "$ITER" "$SEED" "$CORPUS" "$RESULTS"

echo "[3/3] Decoding on the TS side + differential comparison..."
bun "$REPO_ROOT/scripts/wire-decoder-fuzz-differential.ts" "$CORPUS" "$RESULTS"
