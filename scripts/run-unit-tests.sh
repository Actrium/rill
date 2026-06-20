#!/bin/bash
# Run Bun unit tests without repository-wide discovery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BUN_TEST_ARGS=("--timeout=30000")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --coverage)
      BUN_TEST_ARGS+=("--coverage")
      BUN_TEST_ARGS+=("--coverage-dir=../coverage")
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

TEST_FILES=()
while IFS= read -r file; do
  TEST_FILES+=("${file#src/}")
done < <(
  find src -type f \( \
    -name '*.test.ts' -o \
    -name '*.test.tsx' -o \
    -name '*.spec.ts' -o \
    -name '*.spec.tsx' \
  \) | sort
)

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "No unit tests found under src/."
  exit 0
fi

cd "$ROOT_DIR/src"

exec bun test "${BUN_TEST_ARGS[@]}" "${TEST_FILES[@]}"
