#!/bin/bash
# WASM Sandbox E2E Tests - One-shot runner
# Builds WASM, installs deps, runs Playwright tests

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

echo "======================================"
echo "  WASM Sandbox E2E Tests"
echo "======================================"
echo ""

# Check dependencies
echo "[1/4] Checking dependencies..."
if ! command -v bun &> /dev/null; then
  echo "[ERROR] bun is required but not installed"
  exit 1
fi

# Check if WASM files exist
WASM_DIR="$ROOT_DIR/src/host/sandbox/wasm"
if [[ ! -f "$WASM_DIR/quickjs-sandbox.wasm" ]]; then
  echo ""
  echo "[2/4] Building WASM (first time)..."
  cd "$ROOT_DIR/native/quickjs"
  ./build-wasm.sh release
  cd "$ROOT_DIR"
else
  echo "[OK] WASM files exist"
fi

# Install Playwright if needed
PLAYWRIGHT_CLI="$ROOT_DIR/node_modules/playwright/cli.js"
find_node() {
  for candidate in "${PLAYWRIGHT_NODE:-}" "${NODE:-}" node "$HOME/.local/n/bin/node" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [[ -n "$candidate" ]] && "$candidate" --version &> /dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -f "$PLAYWRIGHT_CLI" ]] && NODE_BIN="$(find_node)"; then
  PLAYWRIGHT_CMD=("$NODE_BIN" "$PLAYWRIGHT_CLI")
elif [[ -f "$PLAYWRIGHT_CLI" ]]; then
  PLAYWRIGHT_CMD=(bun "$PLAYWRIGHT_CLI")
else
  PLAYWRIGHT_CMD=(bun x playwright)
fi

if ! "${PLAYWRIGHT_CMD[@]}" --version &> /dev/null; then
  echo "[INFO] Installing Playwright..."
  "${PLAYWRIGHT_CMD[@]}" install chromium
fi

# Run tests
echo ""
echo "[3/4] Starting server..."
echo "[4/4] Running Playwright tests..."
bun tests/wasm-sandbox/run.ts

echo ""
echo "[OK] All WASM E2E tests passed"
