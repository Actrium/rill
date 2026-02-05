#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Guest Bundle Tests ==="
echo ""

# Ensure Bun can write temp files in restricted environments
export TMPDIR="${TMPDIR:-/tmp}/rill-guest-bundle"
mkdir -p "$TMPDIR"

# Step 1: Build guest bundle
echo "[1/2] Building guest bundle..."
bun install --silent && bun run build
echo "     Guest bundle built."

# Step 2: Verify guest bundle
echo "[2/2] Verifying guest bundle..."
bun run verify.ts
