# QuickJS Sandbox - WebAssembly Build Configuration
#
# Build with Emscripten:
#   emcmake cmake -B build-wasm -DBUILD_WASM=ON
#   cmake --build build-wasm
#
# Output:
#   build-wasm/quickjs_sandbox.{js,wasm}

cmake_minimum_required(VERSION 3.10)
project(QuickJSSandboxWASM VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

# Option to enable WASM build
option(BUILD_WASM "Build WebAssembly version" OFF)

# Source directories (same as native)
set(VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
set(JSI_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../jsi)
set(SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src)

# QuickJS Engine sources (C)
set(QUICKJS_SOURCES
    ${VENDOR_DIR}/quickjs.c
    ${VENDOR_DIR}/libregexp.c
    ${VENDOR_DIR}/libunicode.c
    ${VENDOR_DIR}/cutils.c
    ${VENDOR_DIR}/libbf.c
)

# JSI sources (C++)
set(JSI_SOURCES
    ${JSI_DIR}/jsi.cpp
)

# Sandbox sources (C++) - same as native!
set(SANDBOX_SOURCES
    ${SRC_DIR}/HostProxy.cpp
    ${SRC_DIR}/JSIValueConverter.cpp
    ${SRC_DIR}/QuickJSInstrumentation.cpp
    ${SRC_DIR}/QuickJSPointerValue.cpp
    ${SRC_DIR}/QuickJSRuntime.cpp
    ${SRC_DIR}/QuickJSRuntimeFactory.cpp
    ${SRC_DIR}/QuickJSSandboxJSI.cpp
)

# QuickJS compile definitions
set(QUICKJS_DEFINITIONS
    CONFIG_VERSION="2024-01-13"
    CONFIG_BIGNUM
    _GNU_SOURCE
)

if(BUILD_WASM)
    message(STATUS "Building WebAssembly version with Emscripten")

    # Create WASM library
    add_executable(quickjs_sandbox_wasm
        ${QUICKJS_SOURCES}
        ${JSI_SOURCES}
        ${SANDBOX_SOURCES}
    )

    target_compile_definitions(quickjs_sandbox_wasm PRIVATE ${QUICKJS_DEFINITIONS})

    target_include_directories(quickjs_sandbox_wasm PRIVATE
        ${JSI_DIR}
        ${SRC_DIR}
        ${VENDOR_DIR}
    )

    # ⭐ Emscripten-specific settings
    set(EMSCRIPTEN_FLAGS
        # Enable C++ exceptions (needed for JSI)
        -fexceptions

        # Export runtime functions
        -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','addFunction','removeFunction']

        # Export functions to JavaScript
        -s EXPORTED_FUNCTIONS=['_malloc','_free']

        # Allow memory growth (for dynamic allocations)
        -s ALLOW_MEMORY_GROWTH=1

        # Initial memory size (16MB)
        -s INITIAL_MEMORY=16777216

        # Enable dynamic linking for callbacks
        -s ALLOW_TABLE_GROWTH=1

        # Modularize output (creates a factory function)
        -s MODULARIZE=1
        -s EXPORT_NAME='createQuickJSSandbox'

        # Environment
        -s ENVIRONMENT='web,worker,node'

        # Optimization
        -O3

        # Generate TypeScript declarations
        -s EXPORT_ES6=1
    )

    target_link_options(quickjs_sandbox_wasm PRIVATE ${EMSCRIPTEN_FLAGS})

    # Output name
    set_target_properties(quickjs_sandbox_wasm PROPERTIES
        OUTPUT_NAME "quickjs_sandbox"
        SUFFIX ".js"
    )

else()
    # Native build (existing configuration)
    include(${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt)
endif()

# Print summary
message(STATUS "")
message(STATUS "QuickJS Sandbox WASM Configuration:")
message(STATUS "  Build WASM:     ${BUILD_WASM}")
message(STATUS "  Compiler:       ${CMAKE_CXX_COMPILER_ID}")
message(STATUS "")
