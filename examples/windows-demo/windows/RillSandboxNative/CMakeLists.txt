# CMake build for Rill sandbox static library on Windows.
#
# Builds either QuickJS or Hermes sandbox engine based on RILL_SANDBOX_ENGINE.
#
# Usage (from windows-demo/):
#   cmake -S windows/RillSandboxNative -B windows/RillSandboxNative/build \
#     -G "Visual Studio 17 2022" [-DRILL_SANDBOX_ENGINE=hermes]
#   cmake --build windows/RillSandboxNative/build --config Release

cmake_minimum_required(VERSION 3.16)
project(RillSandbox VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 17)

# Engine selection: "quickjs" (default) or "hermes"
set(RILL_SANDBOX_ENGINE "quickjs" CACHE STRING "Sandbox engine: quickjs or hermes")

# Match CRT with react-native-windows app (/MT for Release, /MTd for Debug)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Path to rill native sources (relative to this CMakeLists.txt)
set(RILL_NATIVE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../native)

# CRITICAL: Use RNW's JSI headers, NOT rill's native/jsi/.
# RNW's jsi::Runtime has a different vtable layout (fewer virtual methods).
# Using the wrong jsi.h causes vtable offset mismatches when calling virtual
# methods on JsiAbiRuntime, resulting in ACCESS_VIOLATION crashes.
#
# The JSI headers ship in the Microsoft.ReactNative.Cxx NuGet package,
# NOT in the npm react-native-windows package.
if(NOT RNW_CXX_DIR)
    # Auto-detect from NuGet global packages cache
    set(_NUGET_ROOT "$ENV{USERPROFILE}/.nuget/packages")
    string(REPLACE "\\" "/" _NUGET_ROOT "${_NUGET_ROOT}")
    file(GLOB _RNW_CXX_VERSIONS "${_NUGET_ROOT}/microsoft.reactnative.cxx/0.81.*")
    if(_RNW_CXX_VERSIONS)
        list(SORT _RNW_CXX_VERSIONS)
        list(GET _RNW_CXX_VERSIONS -1 _RNW_CXX_PKG)
        set(RNW_CXX_DIR "${_RNW_CXX_PKG}/tools/Microsoft.ReactNative.Cxx")
    endif()
endif()
if(NOT RNW_CXX_DIR OR NOT EXISTS "${RNW_CXX_DIR}/JSI/jsi.cpp")
    message(FATAL_ERROR "Microsoft.ReactNative.Cxx NuGet package not found. "
        "Run 'msbuild /t:Restore' on the .sln first, or pass -DRNW_CXX_DIR=...")
endif()
message(STATUS "RNW CXX dir: ${RNW_CXX_DIR}")

# JSI sources (C++) — use RNW's version for ABI compatibility
set(JSI_SOURCES
    ${RNW_CXX_DIR}/JSI/jsi.cpp
)

# SandboxEngineConfig.h include path
set(CORE_DIR ${RILL_NATIVE_DIR}/core/src)

# =============================================================================
# QuickJS engine
# =============================================================================
if(RILL_SANDBOX_ENGINE STREQUAL "quickjs")

set(QUICKJS_DIR ${RILL_NATIVE_DIR}/quickjs)

# ─── MSVC patches for quickjs.c ────────────────────────────────────────
# QuickJS was written for GCC/Clang. Several patches are needed for MSVC:
#  1. "1.0 / 0.0" → overflow expression (MSVC C2124: divide by zero)
#  2. Remove redundant (JSValue)v casts (MSVC C forbids struct-to-same-struct casts)
if(MSVC)
    file(READ ${QUICKJS_DIR}/vendor/quickjs.c _QJS_SRC)

    # Patch 1: infinity constant
    string(REPLACE "1.0 / 0.0" "((double)(1e+300 * 1e+300))" _QJS_SRC "${_QJS_SRC}")

    # Patch 2: remove redundant (JSValue) and (JSValueConst) casts
    # In non-NaN-boxing mode, JSValueConst == JSValue, so these are no-ops.
    # MSVC's C compiler rejects casting a struct to the same struct type (C2440).
    string(REGEX REPLACE "\\(JSValue\\)([a-zA-Z_])" "\\1" _QJS_SRC "${_QJS_SRC}")
    string(REGEX REPLACE "\\(JSValueConst\\)([a-zA-Z_])" "\\1" _QJS_SRC "${_QJS_SRC}")

    # Patch 3: MSVC-compatible js_get_stack_pointer for CONFIG_STACK_CHECK.
    # The original uses __builtin_frame_address(0) which is GCC/Clang only.
    # Replace with a portable local-variable-address approach.
    string(REPLACE
        "static inline uintptr_t js_get_stack_pointer(void)\n{\n    return (uintptr_t)__builtin_frame_address(0);\n}"
        "static inline uintptr_t js_get_stack_pointer(void)\n{\n#ifdef _MSC_VER\n    /* MSVC: use address of local as stack pointer approximation */\n    volatile uintptr_t _sp_local;\n    return (uintptr_t)&_sp_local;\n#else\n    return (uintptr_t)__builtin_frame_address(0);\n#endif\n}"
        _QJS_SRC "${_QJS_SRC}"
    )

    file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/quickjs_patched.c "${_QJS_SRC}")
    set(QUICKJS_MAIN_SRC ${CMAKE_CURRENT_BINARY_DIR}/quickjs_patched.c)
else()
    set(QUICKJS_MAIN_SRC ${QUICKJS_DIR}/vendor/quickjs.c)
endif()

# ─── MSVC patches for quickjs.h ────────────────────────────────────────
# On 64-bit MSVC, JS_NAN_BOXING MUST NOT be used because NaN boxing truncates
# 64-bit pointers to 32 bits (JS_MKPTR stores pointers in the lower 32 bits of
# a uint64_t, destroying the upper 32 bits of heap addresses on 64-bit Windows).
#
# Without NaN boxing, JSValue is a struct with a union + tag. This requires:
#  1. Compound literals (JSValue){...} for JS_MKVAL/JS_MKPTR — works in MSVC C17
#     but NOT in MSVC C++ mode. Replaced with inline functions for C++.
#  2. Removing (JSValue)v casts (same issue as quickjs.c).
if(MSVC)
    file(READ ${QUICKJS_DIR}/vendor/quickjs.h _QJH_SRC)

    # Remove redundant (JSValue) casts in inline functions
    string(REGEX REPLACE "return \\(JSValue\\)v;" "return v;" _QJH_SRC "${_QJH_SRC}")

    # Replace the compound-literal macros with C/C++ compatible versions.
    # The originals are:
    #   #define JS_MKVAL(tag, val) (JSValue){ (JSValueUnion){ .int32 = val }, tag }
    #   #define JS_MKPTR(tag, p)   (JSValue){ (JSValueUnion){ .ptr = p }, tag }
    #   #define JS_NAN             (JSValue){ .u.float64 = JS_FLOAT64_NAN, JS_TAG_FLOAT64 }
    #
    # These use compound literals which work in C11+ but not in MSVC C++.
    # Replace with a block that uses inline functions for C++ and keeps
    # compound literals for C.
    string(REPLACE
        "#define JS_MKVAL(tag, val) (JSValue){ (JSValueUnion){ .int32 = val }, tag }\n#define JS_MKPTR(tag, p) (JSValue){ (JSValueUnion){ .ptr = p }, tag }\n\n#define JS_TAG_IS_FLOAT64(tag) ((unsigned)(tag) == JS_TAG_FLOAT64)\n\n#define JS_NAN (JSValue){ .u.float64 = JS_FLOAT64_NAN, JS_TAG_FLOAT64 }"
        "#if defined(_MSC_VER) && defined(__cplusplus)\n/* MSVC C++ does not support compound literals. Use inline helpers. */\nstatic inline JSValue JS_MKVAL_fn_(int64_t tag, int32_t val) { JSValue v; v.u.int32 = val; v.tag = tag; return v; }\nstatic inline JSValue JS_MKPTR_fn_(int64_t tag, void *p) { JSValue v; v.u.ptr = p; v.tag = tag; return v; }\nstatic inline JSValue JS_NAN_fn_(void) { JSValue v; v.tag = JS_TAG_FLOAT64; v.u.float64 = JS_FLOAT64_NAN; return v; }\n#define JS_MKVAL(tag, val) JS_MKVAL_fn_((tag), (val))\n#define JS_MKPTR(tag, p) JS_MKPTR_fn_((tag), (p))\n#define JS_NAN JS_NAN_fn_()\n#else\n#define JS_MKVAL(tag, val) (JSValue){ (JSValueUnion){ .int32 = val }, tag }\n#define JS_MKPTR(tag, p) (JSValue){ (JSValueUnion){ .ptr = p }, tag }\n#define JS_NAN (JSValue){ .u.float64 = JS_FLOAT64_NAN, JS_TAG_FLOAT64 }\n#endif\n\n#define JS_TAG_IS_FLOAT64(tag) ((unsigned)(tag) == JS_TAG_FLOAT64)"
        _QJH_SRC "${_QJH_SRC}"
    )

    file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/quickjs.h "${_QJH_SRC}")
    message(STATUS "Wrote patched quickjs.h to ${CMAKE_CURRENT_BINARY_DIR}/quickjs.h")
endif()

# QuickJS vendor sources (C)
# Note: libbf.c excluded on MSVC — requires __int128 (GCC/Clang only).
# BigNum (BigInt/BigFloat) is disabled via omitting CONFIG_BIGNUM.
set(QUICKJS_SOURCES
    ${QUICKJS_MAIN_SRC}
    ${QUICKJS_DIR}/vendor/libregexp.c
    ${QUICKJS_DIR}/vendor/libunicode.c
    ${QUICKJS_DIR}/vendor/cutils.c
)

# QuickJS sandbox bridge sources (C++)
# NOTE: QuickJSRuntime.cpp and QuickJSRuntimeFactory.cpp are excluded — they are
# the full JSI runtime (for non-sandbox use) and depend on jsilib.h which has
# incompatible relative includes. The sandbox only needs QuickJSSandboxJSI.cpp.
set(SANDBOX_SOURCES
    ${QUICKJS_DIR}/src/HostProxy.cpp
    ${QUICKJS_DIR}/src/JSIValueConverter.cpp
    ${QUICKJS_DIR}/src/QuickJSInstrumentation.cpp
    ${QUICKJS_DIR}/src/QuickJSPointerValue.cpp
    ${QUICKJS_DIR}/src/QuickJSSandboxJSI.cpp
)

# CONFIG_BIGNUM omitted on Windows (requires __int128 via libbf.c)
# NOTE: JS_NAN_BOXING is NOT defined — on 64-bit it truncates pointers!
set(QUICKJS_DEFINITIONS
    CONFIG_VERSION="2024-01-13"
)

# Static library — unified name
add_library(rill_sandbox STATIC
    ${QUICKJS_SOURCES}
    ${JSI_SOURCES}
    ${SANDBOX_SOURCES}
)

target_compile_definitions(rill_sandbox PRIVATE
    ${QUICKJS_DEFINITIONS}
    RILL_SANDBOX_ENGINE=3  # RILL_SANDBOX_ENGINE_QUICKJS
)

# Patched quickjs.h must come FIRST so it overrides the vendor version.
# CRITICAL: Use RNW's JSI headers (Microsoft.ReactNative.Cxx/) for ABI compat.
# On Windows, the path JSI/jsi.h matches case-insensitively with <jsi/jsi.h>.
# RILL_NATIVE_DIR comes AFTER RNW so that jsi/jsi.h resolves to RNW's version,
# but jsi/jsilib.h (not in RNW) falls through to our native/ copy.
target_include_directories(rill_sandbox PUBLIC
    ${CMAKE_CURRENT_BINARY_DIR}  # patched quickjs.h
    ${RNW_CXX_DIR}       # for <jsi/jsi.h> → RNW's JSI/jsi.h (ABI compatible)
    ${RILL_NATIVE_DIR}   # fallback for <jsi/jsilib.h> etc.
    ${CORE_DIR}           # for SandboxEngineConfig.h
    ${QUICKJS_DIR}/src
    ${QUICKJS_DIR}/vendor
)

# MSVC shims directory (provides sys/time.h etc.) — must come BEFORE system includes
if(MSVC)
    target_include_directories(rill_sandbox BEFORE PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/msvc-shims
    )
endif()

# MSVC: compatibility shims for GCC builtins, sys/time.h, packed structs
if(MSVC)
    # Force-include compat header for ALL sources (C and C++ both use QuickJS headers)
    set(COMPAT_HEADER "${CMAKE_CURRENT_SOURCE_DIR}/quickjs-win32-compat.h")
    target_compile_options(rill_sandbox PRIVATE "/FI${COMPAT_HEADER}" /utf-8)

    # Define EMSCRIPTEN for QuickJS C sources to disable:
    #   - DIRECT_DISPATCH (computed gotos — GCC/Clang extension, not supported by MSVC)
    #   - CONFIG_ATOMICS (Atomics.* JS API — not needed in sandbox, avoids pthread dep)
    # Also define CONFIG_STACK_CHECK to RE-ENABLE stack overflow protection.
    # Without stack checking, parsing large JS files (>100KB) crashes with ACCESS_VIOLATION.
    # The EMSCRIPTEN define normally disables it, but we override via explicit define.
    # Safe because _WIN32 is checked before EMSCRIPTEN in malloc_usable_size → _msize still used.
    # /w: suppress warnings, /Oi-: disable intrinsics (math funcs need addresses
    # for function pointer tables like js_math_funcs[])
    set_source_files_properties(${QUICKJS_SOURCES} PROPERTIES
        COMPILE_DEFINITIONS "EMSCRIPTEN;CONFIG_STACK_CHECK"
        COMPILE_OPTIONS "/w;/Oi-"
    )

    # QuickJS uses some POSIX functions
    target_compile_definitions(rill_sandbox PRIVATE
        _CRT_SECURE_NO_WARNINGS
        _CRT_NONSTDC_NO_DEPRECATE
    )

    # Avoid winsock2/windows.h ordering issues
    target_compile_definitions(rill_sandbox PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
    )
endif()

message(STATUS "")
message(STATUS "Rill Sandbox (Windows) Configuration:")
message(STATUS "  Engine:        QuickJS")
message(STATUS "  Build type:    ${CMAKE_BUILD_TYPE}")
message(STATUS "  QuickJS dir:   ${QUICKJS_DIR}")
message(STATUS "  JSI dir:       ${RNW_CXX_DIR}/JSI (RNW ABI-compatible)")
message(STATUS "  NaN boxing:    OFF (64-bit struct JSValue)")
message(STATUS "")

# =============================================================================
# Hermes engine (N-API backend)
# =============================================================================
elseif(RILL_SANDBOX_ENGINE STREQUAL "hermes")

set(HERMES_DIR ${RILL_NATIVE_DIR}/hermes)

# Hermes NuGet package location — passed by the build script or auto-detected
# from the NuGet global packages cache.
if(NOT HERMES_NUGET_DIR)
    # Default: NuGet global packages folder
    set(HERMES_NUGET_DIR "$ENV{USERPROFILE}/.nuget/packages/microsoft.javascript.hermes/0.0.0-2511.7001-d7ca19b3")
    # Convert backslashes for CMake
    string(REPLACE "\\" "/" HERMES_NUGET_DIR "${HERMES_NUGET_DIR}")
endif()

set(HERMES_INCLUDE_DIR "${HERMES_NUGET_DIR}/build/native/include")

# Platform-specific lib path (x64 desktop)
if("${CMAKE_GENERATOR_PLATFORM}" STREQUAL "ARM64")
    set(HERMES_LIB_DIR "${HERMES_NUGET_DIR}/build/native/win32/arm64")
elseif("${CMAKE_GENERATOR_PLATFORM}" STREQUAL "Win32" OR "${CMAKE_GENERATOR_PLATFORM}" STREQUAL "x86")
    set(HERMES_LIB_DIR "${HERMES_NUGET_DIR}/build/native/win32/x86")
else()
    set(HERMES_LIB_DIR "${HERMES_NUGET_DIR}/build/native/win32/x64")
endif()

set(HERMES_LIB "${HERMES_LIB_DIR}/hermes.lib")

if(NOT EXISTS "${HERMES_INCLUDE_DIR}/hermes/js_runtime_api.h" OR NOT EXISTS "${HERMES_LIB}")
    message(FATAL_ERROR "Hermes NuGet NOT found at ${HERMES_NUGET_DIR}. "
        "Install the Microsoft.JavaScript.Hermes NuGet package first.")
endif()

set(HERMES_SANDBOX_SOURCES
    ${HERMES_DIR}/src/HermesSandboxNAPI.cpp
)

add_library(rill_sandbox STATIC
    ${HERMES_SANDBOX_SOURCES}
    ${JSI_SOURCES}
)

target_compile_definitions(rill_sandbox PRIVATE
    BUILDING_NODE_EXTENSION
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    RILL_SANDBOX_ENGINE=2  # RILL_SANDBOX_ENGINE_HERMES
)

target_include_directories(rill_sandbox PUBLIC
    ${RNW_CXX_DIR}            # for <jsi/jsi.h> — RNW ABI-compatible
    ${RILL_NATIVE_DIR}        # fallback for <jsi/jsilib.h>
    ${CORE_DIR}               # for SandboxEngineConfig.h
    ${HERMES_DIR}/src         # for HermesSandboxNAPI.h
    ${HERMES_INCLUDE_DIR}     # for <hermes/js_runtime_api.h>, <node-api/*.h>
    ${HERMES_INCLUDE_DIR}/node-api  # for <node_api.h> included by js_runtime_api.h
)

target_link_libraries(rill_sandbox PRIVATE
    "${HERMES_LIB}"
)

message(STATUS "")
message(STATUS "Rill Sandbox (Windows) Configuration:")
message(STATUS "  Engine:        Hermes (N-API)")
message(STATUS "  Hermes NuGet:  ${HERMES_NUGET_DIR}")
message(STATUS "  Include dir:   ${HERMES_INCLUDE_DIR}")
message(STATUS "  Hermes lib:    ${HERMES_LIB}")
message(STATUS "")

else()
    message(FATAL_ERROR "Unknown RILL_SANDBOX_ENGINE: '${RILL_SANDBOX_ENGINE}'. Use 'quickjs' or 'hermes'.")
endif()
