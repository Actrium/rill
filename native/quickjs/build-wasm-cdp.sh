#!/bin/bash
# Build the FAT CDP debug wasm (Milestone B, browser E2E): the real CDP engine
# (AdapterDebugTarget -> DebuggerAdapter -> QuickJSEngineDebugger -> core) compiled
# to wasm with Asyncify, so the wasm speaks raw Chrome DevTools Protocol directly.
# Separate artifact (build-debug/quickjs-cdp-debug.{mjs,wasm}); never shipped
# (Asyncify ~triples size and the CDP engine is dev-only).
#
# Prerequisites: source the emsdk environment first, e.g.
#   source /ext/emsdk/emsdk_env.sh
#
# Licensed under the Apache License, Version 2.0.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/vendor"
SRC_DIR="${SCRIPT_DIR}/src"
CORE_DIR="${SCRIPT_DIR}/../core/src"
OUT_DIR="${SCRIPT_DIR}/build-debug"

if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Source the emsdk environment first:" >&2
    echo "  source /ext/emsdk/emsdk_env.sh" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"
OUTPUT="${OUT_DIR}/quickjs-cdp-debug.mjs"

# QuickJS engine + the debug core + the Asyncify shim + the real CDP engine
# (engine debugger + adapter + relay target + the pure JSON wire helpers) + the
# fat CDP bindings.
SOURCES=(
    "${VENDOR_DIR}/quickjs.c"
    "${VENDOR_DIR}/libregexp.c"
    "${VENDOR_DIR}/libunicode.c"
    "${VENDOR_DIR}/cutils.c"
    "${VENDOR_DIR}/libbf.c"
    "${SRC_DIR}/QuickJSDebugCore.cpp"
    "${SRC_DIR}/qjs_dbg_suspend.c"
    "${SRC_DIR}/QuickJSEngineDebugger.cpp"
    "${CORE_DIR}/devtools/DebuggerAdapter.cpp"
    "${CORE_DIR}/devtools/AdapterDebugTarget.cpp"
    "${CORE_DIR}/devtools/cdp_wire.cpp"
    "${SRC_DIR}/qjs_cdp_wasm_bindings.cpp"
)

DEFINES=(
    -DCONFIG_VERSION='"2024-01-13"'
    -DCONFIG_BIGNUM
    -D_GNU_SOURCE
    -DEMSCRIPTEN
    -DRILL_QJS_DEBUG
    -DRILL_WIP_CDP_DEVTOOLS=1
)

echo "Building QuickJS FAT CDP debug wasm (Asyncify ON)..."
emcc "${SOURCES[@]}" "${DEFINES[@]}" \
    -O1 \
    -Wno-error=incompatible-function-pointer-types \
    -I"${VENDOR_DIR}" -I"${SRC_DIR}" -I"${CORE_DIR}" \
    -sASYNCIFY=1 \
    -sASYNCIFY_STACK_SIZE=1048576 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createQuickJSCdpDebug \
    -sENVIRONMENT=node,web,worker \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_qjsd_cdp_init,_qjsd_cdp_connect,_qjsd_cdp_disconnect,_qjsd_cdp_dispatch,_qjsd_cdp_eval \
    -o "${OUTPUT}"

WASM="${OUTPUT%.mjs}.wasm"
echo "Built: ${OUTPUT}"
[ -f "${WASM}" ] && echo "wasm size: $(wc -c < "${WASM}") bytes"
