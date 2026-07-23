#!/usr/bin/env bash
# Build the QuickJS CDP stdio host (cdp_stdio_host.cpp). Portable C/C++.
# Output: $OUT (default ./cdp_stdio_host).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/../vendor"
QSRC="$HERE/../src"
CORE="$HERE/../../core/src"
OUT="${OUT:-$HERE/cdp_stdio_host}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

CC="${CC:-clang}"; CXX="${CXX:-clang++}"
CFLAGS="-DRILL_QJS_DEBUG -D_GNU_SOURCE -O1 -funsigned-char -I $VENDOR"
CXXFLAGS="-std=c++17 -DRILL_QJS_DEBUG -DRILL_WIP_CDP_DEVTOOLS=1 -O1 -I $VENDOR -I $QSRC -I $CORE"

for c in quickjs libregexp libunicode cutils; do
  $CC $CFLAGS -c "$VENDOR/$c.c" -o "$WORK/$c.o"
done
for cpp in "$QSRC/QuickJSDebugCore.cpp" "$QSRC/QuickJSEngineDebugger.cpp" \
           "$CORE/devtools/DebuggerAdapter.cpp" "$CORE/devtools/AdapterDebugTarget.cpp" \
           "$CORE/devtools/CDPServer.cpp" "$CORE/devtools/cdp_wire.cpp" \
           "$HERE/cdp_stdio_host.cpp"; do
  $CXX $CXXFLAGS -c "$cpp" -o "$WORK/$(basename "$cpp").o"
done
$CXX "$WORK"/*.o -lpthread -lm -ldl -o "$OUT"
echo "built: $OUT"
