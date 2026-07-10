#!/bin/bash
# Build the QuickJS DEBUG wasm (Milestone B): the real QuickJSDebugCore compiled
# to wasm with Emscripten Asyncify, so a breakpoint suspends the guest by
# unwinding the C stack instead of blocking a thread. Produces a SEPARATE
# artifact (build-debug/quickjs-sandbox-debug.{mjs,wasm}) and never touches the
# production wasm — Asyncify roughly triples code size and slows every eval, so
# it must stay out of the shipping build.
#
# Prerequisites: source the emsdk environment first, e.g.
#   source /ext/emsdk/emsdk_env.sh
#
# Licensed under the Apache License, Version 2.0.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/vendor"
SRC_DIR="${SCRIPT_DIR}/src"
OUT_DIR="${SCRIPT_DIR}/build-debug"

if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Source the emsdk environment first:" >&2
    echo "  source /ext/emsdk/emsdk_env.sh" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"
OUTPUT="${OUT_DIR}/quickjs-sandbox-debug.mjs"

# QuickJS engine (same vendor set as production) + the real debug core + the
# Asyncify shim + the node-facing bindings.
SOURCES=(
    "${VENDOR_DIR}/quickjs.c"
    "${VENDOR_DIR}/libregexp.c"
    "${VENDOR_DIR}/libunicode.c"
    "${VENDOR_DIR}/cutils.c"
    "${VENDOR_DIR}/libbf.c"
    "${SRC_DIR}/QuickJSDebugCore.cpp"
    "${SRC_DIR}/qjs_dbg_suspend.c"
    "${SRC_DIR}/qjs_debug_wasm_bindings.cpp"
)

DEFINES=(
    -DCONFIG_VERSION='"2024-01-13"'
    -DCONFIG_BIGNUM
    -D_GNU_SOURCE
    -DEMSCRIPTEN
    -DRILL_QJS_DEBUG
)

echo "Building QuickJS debug wasm (Asyncify ON)..."
emcc "${SOURCES[@]}" "${DEFINES[@]}" \
    -O1 \
    -Wno-error=incompatible-function-pointer-types \
    -I"${VENDOR_DIR}" -I"${SRC_DIR}" \
    -sASYNCIFY=1 \
    -sASYNCIFY_STACK_SIZE=1048576 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createQuickJSSandboxDebug \
    -sENVIRONMENT=node,web,worker \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_qjsd_init,_qjsd_add_breakpoint,_qjsd_eval,_qjsd_resume,_qjsd_step_into,_qjsd_step_over,_qjsd_step_out,_qjsd_request_pause,_qjsd_is_paused,_qjsd_paused_line,_qjsd_frame_count,_qjsd_frame_line \
    -o "${OUTPUT}"

WASM="${OUTPUT%.mjs}.wasm"
echo "Built: ${OUTPUT}"
[ -f "${WASM}" ] && echo "wasm size: $(wc -c < "${WASM}") bytes"
