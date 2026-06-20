#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Guest Bundle Tests ==="
echo ""

# Ensure Bun can write temp files in restricted environments
export TMPDIR="${TMPDIR:-/tmp}/rill-guest-bundle"
mkdir -p "$TMPDIR"

# Step 1: Build legacy guest bundle
echo "[1/4] Building guest bundle..."
bun install --silent && bun run build
echo "     Guest bundle built."

# Step 2: Verify legacy guest bundle
echo "[2/4] Verifying guest bundle..."
bun run verify.ts

# Step 3: Build host module guest bundle
echo "[3/4] Building host module guest bundle..."
bun ../../src/cli/bin.ts build src/host-modules.tsx \
  -o dist/host-modules.bundle.js \
  --contract src/rill.contract.ts \
  --capability-manifest dist/rill-capabilities.json \
  --no-minify
echo "     Host module guest bundle built."

# Step 4: Verify host module bundle metadata
echo "[4/4] Verifying host module bundle..."
bun run verify-host-modules.ts
