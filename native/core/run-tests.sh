#!/bin/bash
# Rill Core Native Tests - One-shot runner
# Builds and runs core C++ tests (TimerWheel, TenantThread, ThreadPool, TenantContext, TenantRegistry).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================"
echo "  Rill Core Native Tests"
echo "======================================"
echo ""

echo "[1/2] Building..."
make clean > /dev/null 2>&1 || true
make -j"$(getconf _NPROCESSORS_ONLN)"

echo ""
echo "[2/2] Running tests..."
make test

echo ""
echo "[OK] All core native tests passed"

