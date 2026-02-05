cmake_minimum_required(VERSION 3.13)
project(appmodules)

# Include React Native's standard application cmake setup.
# This handles autolinking, TurboModule registration (PlatformConstants, etc.),
# and links against jsi, reactnative, fbjni.
# It also auto-globs *.cpp in this directory, so RillPerformanceBridge.cpp
# is compiled into the library automatically.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# Additional link libraries for our JNI code (android log for __android_log_print)
target_link_libraries(${CMAKE_PROJECT_NAME} android log)
