#!/usr/bin/env bash
# Build + run the Hermes CDP relay native e2e (test_cdp_e2e.cpp).
#
# Requires a React Native Hermes pod built WITH the debugger (CDP symbols) — a
# debug build ships them. Point HERMES_DESTROOT at that pod's `destroot`:
#
#   HERMES_DESTROOT=/path/to/Pods/hermes-engine/destroot ./build-run.sh
#
# destroot must contain:
#   include/hermes/{hermes.h,cdp/*,AsyncDebuggerAPI.h} and include/jsi/*
#   Library/Frameworks/<platform>/hermes.framework
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CORE_SRC="$HERE/../../core/src"
HERMES_SRC="$HERE/../src"

: "${HERMES_DESTROOT:?set HERMES_DESTROOT to a Hermes pod destroot (see header)}"
INCLUDE="$HERMES_DESTROOT/include"

# Locate hermes.framework under Library/Frameworks/<platform>/.
FWDIR="$(dirname "$(find "$HERMES_DESTROOT/Library/Frameworks" -name hermes.framework -maxdepth 2 | head -1)")"
[ -n "$FWDIR" ] || { echo "hermes.framework not found under $HERMES_DESTROOT" >&2; exit 1; }

OUT="${TMPDIR:-/tmp}/rill_cdp_e2e"

clang++ -std=c++17 -DRILL_WIP_CDP_DEVTOOLS=1 -DHERMES_ENABLE_DEBUGGER=1 \
  -I "$INCLUDE" -I "$HERMES_SRC/devtools" -I "$CORE_SRC" \
  "$HERE/test_cdp_e2e.cpp" "$HERMES_SRC/devtools/CDPAgentTarget.cpp" \
  -F "$FWDIR" -framework hermes -Wl,-rpath,"$FWDIR" \
  -o "$OUT"

DYLD_FRAMEWORK_PATH="$FWDIR" "$OUT"
