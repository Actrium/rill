#!/bin/bash
# Build the QuickJS Asyncify pause/resume proof of concept (Milestone A).
#
# Usage:
#   ./build-asyncify-poc.sh          # Asyncify ON  -> quickjs-asyncify-poc.mjs
#   ./build-asyncify-poc.sh off      # Asyncify OFF -> quickjs-noasyncify-poc.mjs
#                                     # (negative control, cannot suspend)
#
# Prerequisites: source the emsdk environment first, e.g.
#   source /ext/emsdk/emsdk_env.sh

set -e

MODE="${1:-on}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QJS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${QJS_DIR}/vendor"

if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Source the emsdk environment first:" >&2
    echo "  source /ext/emsdk/emsdk_env.sh" >&2
    exit 1
fi

# QuickJS engine + PoC bindings. Same vendor set as the production wasm build.
SOURCES=(
    "${VENDOR_DIR}/quickjs.c"
    "${VENDOR_DIR}/libregexp.c"
    "${VENDOR_DIR}/libunicode.c"
    "${VENDOR_DIR}/cutils.c"
    "${VENDOR_DIR}/libbf.c"
    "${SCRIPT_DIR}/asyncify_poc.c"
)

# QuickJS defines mirror the production build; RILL_QJS_DEBUG turns on the
# per-context debug seam this PoC drives.
DEFINES=(
    -DCONFIG_VERSION='"2024-01-13"'
    -DCONFIG_BIGNUM
    -D_GNU_SOURCE
    -DEMSCRIPTEN
    -DRILL_QJS_DEBUG
)

COMMON_FLAGS=(
    -O1
    -Wno-error=incompatible-function-pointer-types
    -I"${VENDOR_DIR}"
    -sALLOW_MEMORY_GROWTH=1
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createQuickJSAsyncifyPoc
    -sENVIRONMENT=node,web,worker
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString
    -sEXPORTED_FUNCTIONS=_malloc,_free,_qjs_poc_init,_qjs_poc_set_breakpoint,_qjs_poc_eval
)

if [ "${MODE}" = "off" ]; then
    echo "Building negative control (Asyncify OFF)..."
    OUTPUT="${SCRIPT_DIR}/quickjs-noasyncify-poc.mjs"
    emcc "${SOURCES[@]}" "${DEFINES[@]}" -DPOC_NO_ASYNCIFY \
        "${COMMON_FLAGS[@]}" \
        -o "${OUTPUT}"
else
    echo "Building Asyncify PoC (Asyncify ON)..."
    OUTPUT="${SCRIPT_DIR}/quickjs-asyncify-poc.mjs"
    emcc "${SOURCES[@]}" "${DEFINES[@]}" \
        "${COMMON_FLAGS[@]}" \
        -sASYNCIFY=1 \
        -sASYNCIFY_STACK_SIZE=1048576 \
        -o "${OUTPUT}"
fi

WASM="${OUTPUT%.mjs}.wasm"
echo "Built: ${OUTPUT}"
echo "       ${WASM}"
if [ -f "${WASM}" ]; then
    echo "wasm size: $(wc -c < "${WASM}") bytes"
fi
