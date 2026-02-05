# QuickJS Sandbox - CMake Build Configuration
# Supports: Android NDK, Linux, macOS
#
# Usage:
#   mkdir build && cd build
#   cmake .. -DCMAKE_BUILD_TYPE=Release
#   cmake --build .
#
# Android NDK:
#   cmake .. -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
#            -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-21

cmake_minimum_required(VERSION 3.10)
project(QuickJSSandbox VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

# Options
option(QUICKJS_SANDBOX_BUILD_SHARED "Build shared library" ON)
option(QUICKJS_SANDBOX_BUILD_STATIC "Build static library" ON)
option(QUICKJS_SANDBOX_BUILD_TESTS "Build tests" OFF)

# Android: prefer shared library
if(ANDROID)
    set(QUICKJS_SANDBOX_BUILD_SHARED ON)
    set(QUICKJS_SANDBOX_BUILD_STATIC OFF)
endif()

# Source directories
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

# Sandbox sources (C++)
set(SANDBOX_SOURCES
    ${SRC_DIR}/HostProxy.cpp
    ${SRC_DIR}/JSIValueConverter.cpp
    ${SRC_DIR}/QuickJSInstrumentation.cpp
    ${SRC_DIR}/QuickJSPointerValue.cpp
    ${SRC_DIR}/QuickJSRuntime.cpp
    ${SRC_DIR}/QuickJSRuntimeFactory.cpp
    ${SRC_DIR}/QuickJSSandboxJSI.cpp
)

# Compile definitions for QuickJS
set(QUICKJS_DEFINITIONS
    CONFIG_VERSION="2024-01-13"
    CONFIG_BIGNUM
    _GNU_SOURCE
)

# Compiler flags
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    # Suppress warnings for vendor code
    set_source_files_properties(${QUICKJS_SOURCES} PROPERTIES
        COMPILE_FLAGS "-w"
    )
endif()

# --- Static Library ---
if(QUICKJS_SANDBOX_BUILD_STATIC)
    # QuickJS engine static library
    add_library(quickjs_engine STATIC ${QUICKJS_SOURCES})
    target_compile_definitions(quickjs_engine PRIVATE ${QUICKJS_DEFINITIONS})
    target_include_directories(quickjs_engine PUBLIC ${VENDOR_DIR})

    # QuickJS Sandbox static library
    add_library(quickjs_sandbox_static STATIC ${JSI_SOURCES} ${SANDBOX_SOURCES})
    target_include_directories(quickjs_sandbox_static PUBLIC
        ${JSI_DIR}
        ${SRC_DIR}
        ${VENDOR_DIR}
    )
    target_link_libraries(quickjs_sandbox_static PUBLIC quickjs_engine)
    target_compile_definitions(quickjs_sandbox_static PRIVATE ${QUICKJS_DEFINITIONS})
    set_target_properties(quickjs_sandbox_static PROPERTIES OUTPUT_NAME quickjs_sandbox)

    if(NOT ANDROID)
        target_link_libraries(quickjs_sandbox_static PUBLIC m pthread)
    endif()
endif()

# --- Shared Library ---
if(QUICKJS_SANDBOX_BUILD_SHARED)
    add_library(quickjs_sandbox SHARED
        ${QUICKJS_SOURCES}
        ${JSI_SOURCES}
        ${SANDBOX_SOURCES}
    )
    target_compile_definitions(quickjs_sandbox PRIVATE ${QUICKJS_DEFINITIONS})
    target_include_directories(quickjs_sandbox PUBLIC
        ${JSI_DIR}
        ${SRC_DIR}
        ${VENDOR_DIR}
    )

    if(NOT ANDROID)
        target_link_libraries(quickjs_sandbox PUBLIC m pthread)
    else()
        target_link_libraries(quickjs_sandbox PUBLIC log)
    endif()

    set_target_properties(quickjs_sandbox PROPERTIES
        VERSION ${PROJECT_VERSION}
        SOVERSION 1
    )
endif()

# --- Tests ---
if(QUICKJS_SANDBOX_BUILD_TESTS AND NOT ANDROID)
    enable_testing()

    add_executable(quickjs_sandbox_test
        ${CMAKE_CURRENT_SOURCE_DIR}/test/main.cpp
    )
    target_link_libraries(quickjs_sandbox_test PRIVATE
        quickjs_sandbox_static
    )
    target_include_directories(quickjs_sandbox_test PRIVATE
        ${JSI_DIR}
        ${SRC_DIR}
    )

    add_test(NAME quickjs_sandbox_test COMMAND quickjs_sandbox_test)
endif()

# --- Install ---
include(GNUInstallDirs)

if(QUICKJS_SANDBOX_BUILD_STATIC)
    install(TARGETS quickjs_sandbox_static quickjs_engine
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif()

if(QUICKJS_SANDBOX_BUILD_SHARED)
    install(TARGETS quickjs_sandbox
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif()

install(FILES
    ${SRC_DIR}/QuickJSSandboxJSI.h
    ${SRC_DIR}/QuickJSRuntimeFactory.h
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/quickjs_sandbox
)

install(DIRECTORY ${JSI_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/jsi
    FILES_MATCHING PATTERN "*.h"
)

# Print configuration summary
message(STATUS "")
message(STATUS "QuickJS Sandbox Configuration:")
message(STATUS "  Build type:     ${CMAKE_BUILD_TYPE}")
message(STATUS "  Static library: ${QUICKJS_SANDBOX_BUILD_STATIC}")
message(STATUS "  Shared library: ${QUICKJS_SANDBOX_BUILD_SHARED}")
message(STATUS "  Tests:          ${QUICKJS_SANDBOX_BUILD_TESTS}")
if(ANDROID)
    message(STATUS "  Android ABI:    ${ANDROID_ABI}")
    message(STATUS "  Android API:    ${ANDROID_PLATFORM}")
endif()
message(STATUS "")
