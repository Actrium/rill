#!/usr/bin/env bash
# Build + run the QuickJS engine debug-hook e2e (test_qjs_debug_e2e.cpp).
#
# QuickJS is portable C, so this builds locally with clang — no external SDK.
# The vendored engine is compiled with -DRILL_QJS_DEBUG to enable the (otherwise
# compiled-out) interpreter debug hook.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/../vendor"
SRC="$HERE/../src"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CC="${CC:-clang}"
CXX="${CXX:-clang++}"
CFLAGS="-DRILL_QJS_DEBUG -D_GNU_SOURCE -O0 -g -funsigned-char -I $VENDOR"
CXXFLAGS="-std=c++17 -DRILL_QJS_DEBUG -g -I $VENDOR -I $SRC"

# Vendored engine (C). Bignum is optional and unused here, so libbf is skipped.
for c in quickjs libregexp libunicode cutils; do
  $CC $CFLAGS -c "$VENDOR/$c.c" -o "$TMP/$c.o"
done

$CXX $CXXFLAGS -c "$SRC/QuickJSDebugCore.cpp" -o "$TMP/QuickJSDebugCore.o"
$CXX $CXXFLAGS -c "$HERE/test_qjs_debug_e2e.cpp" -o "$TMP/test.o"

$CXX "$TMP"/*.o -lpthread -lm -ldl -o "$TMP/qjs_debug_e2e"
"$TMP/qjs_debug_e2e"
