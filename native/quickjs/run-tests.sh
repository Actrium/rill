#!/bin/bash
# QuickJS Sandbox Native Tests - One-shot runner
# Builds and runs all native tests, returns non-zero on failure

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================"
echo "  QuickJS Sandbox Native Tests"
echo "======================================"
echo ""

# Clean and build
echo "[1/4] Building..."
make clean > /dev/null 2>&1 || true
make -j$(sysctl -n hw.ncpu 2>/dev/null || echo 4)

# Run tests
echo ""
echo "[2/4] Running tests..."
make test

# Debugger e2e suites: portable C/C++, build locally with clang/gcc — no
# external SDK. These exercise the RILL_QJS_DEBUG engine hook and the full
# CDP relay stack, which the unit tests above compile out.
echo ""
echo "[3/4] Running engine debug-hook e2e..."
bash test/build-run.sh

echo ""
echo "[4/4] Running full-stack CDP e2e..."
bash test/build-run-cdp.sh

echo ""
echo "[OK] All QuickJS native tests passed"
