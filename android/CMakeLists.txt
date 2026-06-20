cmake_minimum_required(VERSION 3.13)
project(RillSandboxNative)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

# Native root (sibling to android/)
get_filename_component(NATIVE_ROOT "${CMAKE_SOURCE_DIR}/../native" ABSOLUTE)

# =============================================================================
# Hermes Sandbox
# =============================================================================
set(HERMES_DIR "${NATIVE_ROOT}/hermes")
set(HERMES_SANDBOX_SOURCES
    ${HERMES_DIR}/src/HermesSandboxJSI.cpp
)

# =============================================================================
# QuickJS Sandbox
# =============================================================================
set(QUICKJS_DIR "${NATIVE_ROOT}/quickjs")
set(JSI_DIR "${NATIVE_ROOT}/jsi")

# QuickJS engine (C sources)
set(QUICKJS_ENGINE_SOURCES
    ${QUICKJS_DIR}/vendor/quickjs.c
    ${QUICKJS_DIR}/vendor/libregexp.c
    ${QUICKJS_DIR}/vendor/libunicode.c
    ${QUICKJS_DIR}/vendor/cutils.c
    ${QUICKJS_DIR}/vendor/libbf.c
)

# QuickJS sandbox bridge (C++ sources)
set(QUICKJS_SANDBOX_SOURCES
    ${QUICKJS_DIR}/src/QuickJSSandboxJSI.cpp
    ${QUICKJS_DIR}/src/QuickJSRuntime.cpp
    ${QUICKJS_DIR}/src/QuickJSRuntimeFactory.cpp
    ${QUICKJS_DIR}/src/QuickJSPointerValue.cpp
    ${QUICKJS_DIR}/src/QuickJSInstrumentation.cpp
    ${QUICKJS_DIR}/src/HostProxy.cpp
    ${QUICKJS_DIR}/src/JSIValueConverter.cpp
)

# Note: JSI implementation (jsi.cpp) is provided by ReactAndroid::jsi
# We only need the headers from native/jsi/ for include paths

# =============================================================================
# JNI entry point
# =============================================================================
set(JNI_SOURCES
    ${CMAKE_SOURCE_DIR}/src/main/jni/RillSandboxAndroid.cpp
)

# =============================================================================
# Shared library target
# =============================================================================
add_library(rillsandbox SHARED
    ${HERMES_SANDBOX_SOURCES}
    ${QUICKJS_ENGINE_SOURCES}
    ${QUICKJS_SANDBOX_SOURCES}
    ${JNI_SOURCES}
)

# QuickJS compile definitions and suppress vendor warnings
set_source_files_properties(${QUICKJS_ENGINE_SOURCES} PROPERTIES
    COMPILE_DEFINITIONS "CONFIG_VERSION=\"2024-01-13\";CONFIG_BIGNUM;_GNU_SOURCE"
    COMPILE_FLAGS "-w"
)

target_include_directories(rillsandbox PRIVATE
    ${HERMES_DIR}/src
    ${QUICKJS_DIR}/src
    ${QUICKJS_DIR}/vendor
)
# jsi/jsi.h is provided by ReactAndroid::jsi (transitive includes)

# Link with React Native's JSI and Hermes
find_package(ReactAndroid REQUIRED CONFIG)
find_package(hermes-engine REQUIRED CONFIG)
target_link_libraries(rillsandbox
    ReactAndroid::jsi
    ReactAndroid::hermestooling
    hermes-engine::hermesvm
    android
    log
)
