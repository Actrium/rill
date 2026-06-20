#!/bin/bash
# Install android-demo to a connected device or emulator
#
# Builds two APK flavors (QuickJS + Hermes) that can be installed
# side-by-side with different applicationIds.
#
# Usage:
#   ./install.sh                     # Build and install both flavors (release)
#   ./install.sh quickjs             # Build and install QuickJS flavor only
#   ./install.sh hermes              # Build and install Hermes flavor only
#   ./install.sh quickjs hermes      # Build and install both (explicit)
#   ./install.sh --debug             # Build debug variants
#
# Options:
#   -v, --verbose   Print full build logs
#   -d, --debug     Build debug variant
#   -r, --release   Build release variant (default)
#   -h, --help      Show this help

set -euo pipefail

cd "$(dirname "$0")"

# Auto-detect ANDROID_HOME if not set
if [ -z "${ANDROID_HOME:-}" ]; then
    if [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    elif [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    fi
fi

# Add SDK tools to PATH if ANDROID_HOME is set
if [ -n "${ANDROID_HOME:-}" ]; then
    for dir in "$ANDROID_HOME/platform-tools" "$ANDROID_HOME/emulator" "$ANDROID_HOME/cmdline-tools/latest/bin"; do
        if [ -d "$dir" ] && [[ ":$PATH:" != *":$dir:"* ]]; then
            export PATH="$dir:$PATH"
        fi
    done
fi

# Prompt to install a missing dependency via Homebrew
brew_install_or_die() {
    local name="$1"
    local formula="${2:-$1}"
    if ! command -v brew >/dev/null 2>&1; then
        echo "Error: '$name' is not installed and Homebrew is not available."
        echo "Install Homebrew (https://brew.sh) then re-run, or install '$name' manually."
        exit 1
    fi
    echo "'$name' is not installed."
    read -r -p "Install via Homebrew (brew install $formula)? [Y/n] " answer
    case "${answer:-y}" in
        [yY]|[yY][eE][sS]|"")
            brew install "$formula"
            ;;
        *)
            echo "Aborted. Please install '$name' manually and re-run."
            exit 1
            ;;
    esac
}

VERBOSE=0
VARIANT="release"
VALID_CONFIGS=("quickjs" "hermes")
CONFIGS_TO_INSTALL=()

# Parse arguments
show_usage() {
    echo ""
    echo "Usage:"
    echo "  ./install.sh                     # Build and install both flavors (release)"
    echo "  ./install.sh quickjs             # Install QuickJS flavor only"
    echo "  ./install.sh hermes              # Install Hermes flavor only"
    echo "  ./install.sh quickjs hermes      # Install both flavors (explicit)"
    echo "  ./install.sh --debug             # Build debug variants"
    echo ""
    echo "Options:"
    echo "  -v, --verbose   Print full build logs"
    echo "  -d, --debug     Build debug variant"
    echo "  -r, --release   Build release variant (default)"
    echo "  -h, --help      Show this help"
}

while [ $# -gt 0 ]; do
    case "$1" in
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -d|--debug)
            VARIANT="debug"
            shift
            ;;
        -r|--release)
            VARIANT="release"
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        quickjs|hermes)
            CONFIGS_TO_INSTALL+=("$1")
            shift
            ;;
        *)
            echo "Warning: Unknown argument '$1'"
            show_usage
            exit 1
            ;;
    esac
done

# Default: install both flavors
if [ ${#CONFIGS_TO_INSTALL[@]} -eq 0 ]; then
    CONFIGS_TO_INSTALL=("${VALID_CONFIGS[@]}")
fi

echo "========================================"
echo "android-demo Installer"
echo "========================================"
echo "Variant: $VARIANT"
echo "Flavors: ${CONFIGS_TO_INSTALL[*]}"
if [ "$VERBOSE" -eq 1 ]; then
    echo "Verbose: enabled"
else
    echo "Verbose: disabled (logs in /tmp/android-demo-*.log)"
fi
echo ""

# Ensure Android SDK tools are available
if ! command -v adb >/dev/null 2>&1; then
    brew_install_or_die "adb" "android-platform-tools"
fi

DEVICE_COUNT=$(adb devices | grep -c -w 'device' || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
    # Try to auto-launch an emulator
    if command -v emulator >/dev/null 2>&1; then
        ALL_AVDS=$(emulator -list-avds 2>&1 | grep -v -E '^(INFO|ERROR|WARNING)\s')
        # Prefer phone AVDs over TV/Wear/Auto
        AVD_NAME=$(echo "$ALL_AVDS" | grep -v -i -E 'tv|wear|auto|car' | head -1)
        # Fall back to any AVD
        if [ -z "$AVD_NAME" ]; then
            AVD_NAME=$(echo "$ALL_AVDS" | head -1)
        fi
        if [ -n "$AVD_NAME" ]; then
            echo "No device connected. Launching emulator: $AVD_NAME"
            emulator -avd "$AVD_NAME" -no-snapshot-load >/dev/null 2>&1 &
            echo "Waiting for emulator to boot..."
            adb wait-for-device
            # Wait for boot animation to finish
            while [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
                sleep 1
            done
            echo "Emulator booted"
        else
            echo "Error: No Android device or emulator connected, and no AVDs found."
            echo "Create an AVD with: avdmanager create avd -n default -k 'system-images;android-35;google_apis;arm64-v8a'"
            exit 1
        fi
    else
        echo "Error: No Android device or emulator connected."
        echo "Start an emulator or connect a device via USB/WiFi."
        exit 1
    fi
fi

DEVICE_NAME=$(adb devices -l | grep -w 'device' | head -1 | awk '{print $1}' || true)
if [ -z "$DEVICE_NAME" ]; then
    echo "Error: Device connected but could not determine device name."
    exit 1
fi
echo "Device: $DEVICE_NAME"
echo ""

# Ensure JS dependencies
ensure_js_deps() {
    if [ -d "node_modules/react-native" ]; then
        return 0
    fi

    if ! command -v npm >/dev/null 2>&1; then
        brew_install_or_die "npm" "node"
    fi

    echo "[setup] Installing JS dependencies..."
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
}

ensure_js_deps

# Ensure Gradle wrapper exists
ensure_gradle_wrapper() {
    if [ -f "android/gradlew" ]; then
        return 0
    fi

    echo "[setup] Generating Gradle wrapper..."

    # Copy wrapper from RN gradle plugin (ships with every RN install)
    local rn_gradle_plugin="node_modules/@react-native/gradle-plugin"
    if [ -f "$rn_gradle_plugin/gradlew" ] && [ -f "$rn_gradle_plugin/gradle/wrapper/gradle-wrapper.jar" ]; then
        cp "$rn_gradle_plugin/gradlew" android/gradlew
        cp "$rn_gradle_plugin/gradlew.bat" android/gradlew.bat 2>/dev/null || true
        cp "$rn_gradle_plugin/gradle/wrapper/gradle-wrapper.jar" android/gradle/wrapper/
        chmod +x android/gradlew
        echo "Gradle wrapper copied from @react-native/gradle-plugin"
        return 0
    fi

    # Fallback: use system gradle
    if ! command -v gradle >/dev/null 2>&1; then
        brew_install_or_die "gradle" "gradle"
    fi
    (cd android && gradle wrapper --no-configuration-cache -p .)
}

ensure_gradle_wrapper

GRADLE_COMMON_ARGS=()
if [ -n "${RILL_ANDROID_GRADLE_INIT:-}" ]; then
    GRADLE_COMMON_ARGS+=("-I" "$RILL_ANDROID_GRADLE_INIT")
fi
if [ -n "${RILL_ANDROID_GRADLE_ARGS:-}" ]; then
    # Intentional shell splitting: callers pass Gradle CLI flags as a single env string.
    EXTRA_GRADLE_ARGS=($RILL_ANDROID_GRADLE_ARGS)
    GRADLE_COMMON_ARGS+=("${EXTRA_GRADLE_ARGS[@]}")
fi

# Bundle JS into APK assets (like iOS install.sh bundles into .app)
bundle_js() {
    local ASSETS_DIR="android/app/src/main/assets"
    mkdir -p "$ASSETS_DIR"

    local DEV_FLAG="true"
    if [ "$VARIANT" = "release" ]; then
        DEV_FLAG="false"
    fi

    echo "[bundle] Creating JS bundle..."
    npx react-native bundle \
        --entry-file index.tsx \
        --platform android \
        --dev "$DEV_FLAG" \
        --bundle-output "$ASSETS_DIR/index.android.bundle" \
        --assets-dest "$ASSETS_DIR"

    echo "[bundle] JS bundle created"
}

bundle_js

# Capitalize first letter for Gradle task name
capitalize() {
    echo "$(echo "${1:0:1}" | tr '[:lower:]' '[:upper:]')${1:1}"
}

VARIANT_CAP=$(capitalize "$VARIANT")

echo "========================================"
echo "Building and installing ($VARIANT)..."
echo "========================================"

for CONFIG in "${CONFIGS_TO_INSTALL[@]}"; do
    CONFIG_CAP=$(capitalize "$CONFIG")
    # Use assemble + adb install instead of Gradle's install task,
    # which has unreliable device matching for release builds.
    GRADLE_TASK=":app:assemble${CONFIG_CAP}${VARIANT_CAP}"
    BUILD_LOG="/tmp/android-demo-build-${CONFIG}-${VARIANT}.log"
    APK_PATH="android/app/build/outputs/apk/${CONFIG}/${VARIANT}/app-${CONFIG}-${VARIANT}.apk"

    echo ""
    echo "── Flavor: $CONFIG ──"

    # Build
    if [ "$VERBOSE" -eq 1 ]; then
        if ! (cd android && ./gradlew "${GRADLE_COMMON_ARGS[@]}" "$GRADLE_TASK" 2>&1 | tee "$BUILD_LOG"); then
            echo ""
            echo "Build failed for $CONFIG (see $BUILD_LOG)"
            exit 1
        fi
    else
        echo "Building $CONFIG... (log: $BUILD_LOG)"
        if ! (cd android && ./gradlew "${GRADLE_COMMON_ARGS[@]}" "$GRADLE_TASK" >"$BUILD_LOG" 2>&1); then
            echo "Build failed for $CONFIG (see $BUILD_LOG)"
            tail -n 40 "$BUILD_LOG" || true
            exit 1
        fi
    fi

    # Install via adb
    if [ ! -f "$APK_PATH" ]; then
        echo "APK not found at $APK_PATH (see $BUILD_LOG)"
        exit 1
    fi
    echo "Installing $CONFIG..."
    if ! adb install -r "$APK_PATH"; then
        echo "Install failed for $CONFIG"
        exit 1
    fi
    echo "$CONFIG OK"
done

echo ""
echo "========================================"
echo "Installation Complete"
echo "========================================"
echo ""
echo "  Variant:  $VARIANT"
echo "  Flavors:  ${CONFIGS_TO_INSTALL[*]}"
echo "  Device:   $DEVICE_NAME"
echo ""
echo "Installed apps:"
for CONFIG in "${CONFIGS_TO_INSTALL[@]}"; do
    CONFIG_CAP=$(capitalize "$CONFIG")
    echo "  - Rill-${CONFIG_CAP} (com.rill.demo.${CONFIG})"
done
echo ""
echo "The JS bundle is pre-built into the APK."
echo "No Metro dev server needed."
echo ""
echo "========================================"
