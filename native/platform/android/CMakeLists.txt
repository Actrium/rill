cmake_minimum_required(VERSION 3.13)
project(RillSandboxNative)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Package root (two levels up from platform/android/)
get_filename_component(PACKAGE_ROOT "${CMAKE_SOURCE_DIR}/../.." ABSOLUTE)

set(QUICKJS_DIR "${PACKAGE_ROOT}/quickjs")
# QuickJS vendor sources
set(QUICKJS_VENDOR_SOURCES
    ${QUICKJS_DIR}/vendor/quickjs.c
    ${QUICKJS_DIR}/vendor/libunicode.c
    ${QUICKJS_DIR}/vendor/libregexp.c
    ${QUICKJS_DIR}/vendor/cutils.c
    ${QUICKJS_DIR}/vendor/libbf.c
)

# QuickJS JSI binding sources
set(QUICKJS_JSI_SOURCES
    ${QUICKJS_DIR}/src/QuickJSRuntime.cpp
    ${QUICKJS_DIR}/src/QuickJSRuntimeFactory.cpp
    ${QUICKJS_DIR}/src/QuickJSPointerValue.cpp
    ${QUICKJS_DIR}/src/QuickJSInstrumentation.cpp
    ${QUICKJS_DIR}/src/JSIValueConverter.cpp
    ${QUICKJS_DIR}/src/HostProxy.cpp
    ${QUICKJS_DIR}/src/QuickJSSandboxJSI.cpp
)

add_library(rillsandbox SHARED
    ${QUICKJS_VENDOR_SOURCES}
    ${QUICKJS_JSI_SOURCES}
    ${CMAKE_SOURCE_DIR}/src/main/cpp/RillSandboxInstaller.cpp
)

target_include_directories(rillsandbox PRIVATE
    ${QUICKJS_DIR}/vendor
    ${QUICKJS_DIR}/src
)

target_compile_definitions(rillsandbox PRIVATE
    CONFIG_VERSION="2024-01-01"
    CONFIG_BIGNUM=1
)

# Suppress warnings from vendor code
set_source_files_properties(${QUICKJS_VENDOR_SOURCES} PROPERTIES
    COMPILE_FLAGS "-w"
)

# Link with React Native's JSI via prefab
find_package(ReactAndroid REQUIRED CONFIG)
target_link_libraries(rillsandbox
    ReactAndroid::jsi
    android
    log
)
