#!/bin/bash
# In-browser CDP debug E2E - one-shot runner.
# Ensures the fat CDP debug wasm exists, then starts the relay + static server and
# runs the Playwright spec (see run.ts for the full chain).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

echo "======================================"
echo "  In-browser CDP debug E2E"
echo "======================================"
echo ""

if ! command -v bun &> /dev/null; then
  echo "[ERROR] bun is required but not installed"
  exit 1
fi

# The fat CDP debug wasm is a dev-only artifact (never shipped); build it if missing.
WASM="$ROOT_DIR/native/quickjs/build-debug/quickjs-cdp-debug.wasm"
if [[ ! -f "$WASM" ]]; then
  echo "[build] fat CDP debug wasm missing; building..."
  if ! command -v emcc &> /dev/null; then
    # shellcheck disable=SC1091
    [[ -f /ext/emsdk/emsdk_env.sh ]] && source /ext/emsdk/emsdk_env.sh
  fi
  bash "$ROOT_DIR/native/quickjs/build-wasm-cdp.sh"
else
  echo "[ok] fat CDP debug wasm present"
fi

# Install Playwright chromium if needed.
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
  echo "[install] Playwright chromium..."
  "${PLAYWRIGHT_CMD[@]}" install chromium
fi

echo ""
echo "[run] relay + static server + Playwright..."
bun tests/cdp-debug/run.ts

echo ""
echo "[ok] in-browser CDP debug E2E passed"
