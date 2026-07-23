#!/usr/bin/env bash
# Build + run the watchdog x debugger-pause reconciliation e2e
# (test_watchdog_pause.cpp). Same requirements as build-run.sh: a React Native
# Hermes pod built WITH the debugger. Point HERMES_DESTROOT at its `destroot`:
#
#   HERMES_DESTROOT=/path/to/Pods/hermes-engine/destroot ./build-run-watchdog.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CORE_SRC="$HERE/../../core/src"
HERMES_SRC="$HERE/../src"

: "${HERMES_DESTROOT:?set HERMES_DESTROOT to a Hermes pod destroot (see header)}"
INCLUDE="$HERMES_DESTROOT/include"

FWDIR="$(dirname "$(find "$HERMES_DESTROOT/Library/Frameworks" -name hermes.framework -maxdepth 2 | head -1)")"
[ -n "$FWDIR" ] || { echo "hermes.framework not found under $HERMES_DESTROOT" >&2; exit 1; }

OUT="${TMPDIR:-/tmp}/rill_watchdog_pause_e2e"

clang++ -std=c++17 -DRILL_WIP_CDP_DEVTOOLS=1 -DHERMES_ENABLE_DEBUGGER=1 \
  -I "$INCLUDE" -I "$HERMES_SRC/devtools" -I "$CORE_SRC" \
  "$HERE/test_watchdog_pause.cpp" "$HERMES_SRC/devtools/CDPAgentTarget.cpp" \
  -F "$FWDIR" -framework hermes -Wl,-rpath,"$FWDIR" \
  -o "$OUT"

DYLD_FRAMEWORK_PATH="$FWDIR" "$OUT"
