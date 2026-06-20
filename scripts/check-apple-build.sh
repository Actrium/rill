#!/bin/bash
# Apple (macOS) build gate for RillSandboxNative.
#
# Goal:
#   - Ensure Objective-C++ native code (including native/core/src/RillTenantManager.mm)
#     compiles in a real React Native build.
#
# How it works:
#   - Uses the repo's RN macOS E2E fixture under tests/rn-macos-bridgeless/
#   - Runs: deps check (non-destructive), npm install (if needed), pods init, xcodebuild
#
# Usage:
#   bash scripts/check-apple-build.sh                 # default specs
#   bash scripts/check-apple-build.sh jsc-jsc         # single spec
#   bash scripts/check-apple-build.sh jsc-jsc jsc-quickjs
#
# Notes:
#   - This repository currently provides a macOS fixture only.
#   - iOS build gating should be done in the consuming app repo until an iOS fixture exists here.

set -euo pipefail

RILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_DIR="$RILL_ROOT/tests/rn-macos-bridgeless"

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "[ERROR] RN macOS fixture not found at: $FIXTURE_DIR" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "[ERROR] xcodebuild not found. Install Xcode / xcode-select first." >&2
  exit 1
fi

if ! command -v pod >/dev/null 2>&1; then
  echo "[ERROR] CocoaPods (pod) not found. Install cocoapods first." >&2
  exit 1
fi

SPECS=("$@")
if [ "${#SPECS[@]}" -eq 0 ]; then
  # Keep it fast but meaningful: default engine (JSC sandbox) + cross-platform engine (QuickJS sandbox)
  SPECS=("jsc-jsc" "jsc-quickjs")
fi

cd "$FIXTURE_DIR"

echo "======================================"
echo "  Apple Build Gate (macOS)"
echo "======================================"
echo "Specs: ${SPECS[*]}"
echo ""

# Ensure JS deps are present (run-tests.sh uses npm).
if [ ! -d node_modules ]; then
  ./run-tests.sh install
fi

for SPEC in "${SPECS[@]}"; do
  echo ""
  echo "==> macOS build: $SPEC"
  ./run-tests.sh init "$SPEC"
  ./run-tests.sh build "$SPEC"
done

echo ""
echo "[OK] Apple build gate passed (macOS)"

