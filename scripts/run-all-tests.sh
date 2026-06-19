#!/bin/bash
# Rill - Master Test Runner
# Runs all tests: unit, native, and E2E
# Returns non-zero if any test suite fails

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

FAILED_SUITES=()
SKIPPED_SUITES=()
PASSED_SUITES=()

run_suite() {
  local name="$1"
  local cmd="$2"

  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  Running: ${name}${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if eval "$cmd"; then
    PASSED_SUITES+=("$name")
    echo -e "${GREEN}[PASS]${NC} ${name}"
  else
    FAILED_SUITES+=("$name")
    echo -e "${RED}[FAIL]${NC} ${name}"
  fi
}

skip_suite() {
  local name="$1"
  local reason="$2"
  SKIPPED_SUITES+=("$name ($reason)")
  echo -e "${YELLOW}[SKIP]${NC} ${name} - ${reason}"
}

echo "======================================"
echo "  Rill - Master Test Runner"
echo "======================================"
echo ""
echo "Platform: $(uname -s)"
echo "Date: $(date)"

# Parse arguments
RUN_NATIVE=true
RUN_E2E=true
RUN_UNIT=true
RUN_RN=false  # RN macOS E2E is opt-in (requires Xcode build)
RUN_IOS_SIM=false  # iOS Simulator E2E is opt-in (requires Xcode simulator)

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-native) RUN_NATIVE=false; shift ;;
    --skip-e2e) RUN_E2E=false; shift ;;
    --skip-unit) RUN_UNIT=false; shift ;;
    --with-rn) RUN_RN=true; shift ;;
    --with-ios-sim) RUN_IOS_SIM=true; shift ;;
    --help)
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --skip-native    Skip native C++/ObjC tests"
      echo "  --skip-e2e       Skip browser E2E tests"
      echo "  --skip-unit      Skip bun unit tests"
      echo "  --with-rn        Include React Native macOS E2E tests (requires Xcode)"
      echo "  --with-ios-sim   Include iOS Simulator E2E tests (requires Xcode simulator)"
      echo "  --help           Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ============================================
# 1. Unit Tests
# ============================================
if [[ "$RUN_UNIT" == true ]]; then
  run_suite "Unit Tests" "bun run test:unit"
fi

# ============================================
# 2. Guest Bundle Tests
# ============================================
if [[ "$RUN_UNIT" == true ]]; then
  if [[ -f "$ROOT_DIR/tests/guest-bundle/run-tests.sh" ]]; then
    run_suite "Guest Bundle (build + verify)" "bash $ROOT_DIR/tests/guest-bundle/run-tests.sh"
  fi
fi

# ============================================
# 3. Native Tests
# ============================================
if [[ "$RUN_NATIVE" == true ]]; then
  run_suite "Native Tests (C++)" "bun run test:native"
fi

# ============================================
# 4. E2E: WASM Sandbox (Playwright)
# ============================================
if [[ "$RUN_E2E" == true ]]; then
  if [[ -f "$ROOT_DIR/tests/wasm-sandbox/run-tests.sh" ]]; then
    run_suite "E2E: WASM Sandbox" "bash $ROOT_DIR/tests/wasm-sandbox/run-tests.sh"
  fi
fi

# ============================================
# 5. React Native E2E (opt-in, requires Xcode)
# ============================================
if [[ "$RUN_RN" == true ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    if [[ -f "$ROOT_DIR/tests/rn-macos-bridgeless/run-tests.sh" ]]; then
      run_suite "E2E: React Native macOS (Bridgeless)" "bash $ROOT_DIR/tests/rn-macos-bridgeless/run-tests.sh all"
    fi
  else
    skip_suite "E2E: React Native macOS" "macOS only"
  fi
fi

# ============================================
# 6. iOS Simulator E2E (opt-in, requires Xcode simulator)
# ============================================
if [[ "$RUN_IOS_SIM" == true ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    if [[ -f "$ROOT_DIR/examples/ios-demo/run-e2e.sh" ]]; then
      run_suite "E2E: iOS Simulator" "bash $ROOT_DIR/examples/ios-demo/run-e2e.sh"
    fi
  else
    skip_suite "E2E: iOS Simulator" "macOS only"
  fi
fi

# ============================================
# Summary
# ============================================
echo ""
echo "======================================"
echo "  Test Summary"
echo "======================================"
echo ""

if [[ ${#PASSED_SUITES[@]} -gt 0 ]]; then
  echo -e "${GREEN}Passed (${#PASSED_SUITES[@]}):${NC}"
  for suite in "${PASSED_SUITES[@]}"; do
    echo "  - $suite"
  done
fi

if [[ ${#SKIPPED_SUITES[@]} -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}Skipped (${#SKIPPED_SUITES[@]}):${NC}"
  for suite in "${SKIPPED_SUITES[@]}"; do
    echo "  - $suite"
  done
fi

if [[ ${#FAILED_SUITES[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed (${#FAILED_SUITES[@]}):${NC}"
  for suite in "${FAILED_SUITES[@]}"; do
    echo "  - $suite"
  done
  echo ""
  exit 1
fi

echo ""
echo -e "${GREEN}All tests passed!${NC}"
exit 0
