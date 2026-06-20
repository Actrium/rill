#!/bin/bash
# Install ios-demo sandbox configurations to the simulator
# Each configuration gets a unique bundle ID so they can coexist
#
# Usage:
#   ./install.sh                        # Install all 3 configurations (release)
#   ./install.sh bridgeless-hermes      # Install specific configuration
#   ./install.sh bridgeless-jsc bridgeless-quickjs  # Install multiple
#   ./install.sh --debug                # Build debug variant
#
# Valid configurations (Bridgeless only):
#   bridgeless-jsc, bridgeless-quickjs, bridgeless-hermes

set -euo pipefail

cd "$(dirname "$0")"

SIMULATOR="${SIMULATOR:-iPhone 16 Pro}"
BASE_BUNDLE_ID="chat.askaway.ios-demo"
VERBOSE=0
VARIANT="release"

# Only Bridgeless configurations
VALID_CONFIGS=("bridgeless-jsc" "bridgeless-quickjs" "bridgeless-hermes")

# Function to check if a config is valid
is_valid_config() {
    local config="$1"
    for valid in "${VALID_CONFIGS[@]}"; do
        if [ "$config" = "$valid" ]; then
            return 0
        fi
    done
    return 1
}

# Capitalize first letter
capitalize() {
    echo "$(echo "${1:0:1}" | tr '[:lower:]' '[:upper:]')${1:1}"
}

# Function to show usage
show_usage() {
    echo ""
    echo "Valid configurations:"
    for config in "${VALID_CONFIGS[@]}"; do
        echo "  - $config"
    done
    echo ""
    echo "Usage:"
    echo "  ./install.sh                              # Install all configurations (release)"
    echo "  ./install.sh bridgeless-hermes            # Install one configuration"
    echo "  ./install.sh bridgeless-jsc bridgeless-quickjs  # Install multiple"
    echo "  ./install.sh --debug                      # Build debug variant"
    echo ""
    echo "Options:"
    echo "  -v, --verbose   Print full build logs"
    echo "  -d, --debug     Build debug variant (default: release)"
    echo "  -r, --release   Build release variant (default)"
    echo "  -h, --help      Show this help"
}

# Parse arguments - flags + determine which configs to install
CONFIGS_TO_INSTALL=()
INVALID_ARGS=()

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
        -*)
            INVALID_ARGS+=("$1")
            shift
            ;;
        *)
            if is_valid_config "$1"; then
                CONFIGS_TO_INSTALL+=("$1")
            else
                INVALID_ARGS+=("$1")
            fi
            shift
            ;;
    esac
done

if [ ${#CONFIGS_TO_INSTALL[@]} -eq 0 ]; then
    # No configs specified: install all
    CONFIGS_TO_INSTALL=("${VALID_CONFIGS[@]}")
fi

# Show warnings for invalid arguments
if [ ${#INVALID_ARGS[@]} -gt 0 ]; then
    echo "Warning: Ignoring invalid configuration(s): ${INVALID_ARGS[*]}"
    show_usage
fi

VARIANT_CAP=$(capitalize "$VARIANT")

echo "========================================"
echo "ios-demo Installer"
echo "========================================"
echo "Variant: $VARIANT"
echo "Installing ${#CONFIGS_TO_INSTALL[@]} configuration(s): ${CONFIGS_TO_INSTALL[*]}"
if [ "$VERBOSE" -eq 1 ]; then
    echo "Verbose: enabled"
else
    echo "Verbose: disabled (logs in /tmp/ios-demo-*.log)"
fi
echo ""

# Find simulator
DEVICE_ID=$(xcrun simctl list devices available | grep "$SIMULATOR" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
if [ -z "$DEVICE_ID" ]; then
    DEVICE_ID=$(xcrun simctl list devices available | grep "iPhone" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
fi

if [ -z "$DEVICE_ID" ]; then
    echo "Error: No iPhone simulator found"
    exit 1
fi

SIMULATOR_NAME=$(xcrun simctl list devices | grep "$DEVICE_ID" | sed -E 's/^[[:space:]]*//' | sed -E 's/\(.*//g' | xargs)
echo "Simulator: $SIMULATOR_NAME ($DEVICE_ID)"
echo ""

# Ensure JS dependencies are installed for the Podfile (react_native_pods)
ensure_js_deps() {
    local rn_pods_script="node_modules/react-native/scripts/react_native_pods.rb"
    if [ -f "$rn_pods_script" ]; then
        return 0
    fi

    if ! command -v node >/dev/null 2>&1; then
        echo "Error: node is not installed (required for React Native pods)"
        return 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo "Error: npm is not installed (required for React Native pods)"
        return 1
    fi

    echo "[setup] Installing JS dependencies..."
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

    if [ ! -f "$rn_pods_script" ]; then
        echo "Error: React Native pods script not found after npm install: $rn_pods_script"
        return 1
    fi
}

ensure_js_deps

# Work around occasional CocoaPods realpath crashes by ensuring codegen outputs exist early.
# RN codegen will overwrite these during `pod install`.
ensure_codegen_placeholders() {
    local dir="build/generated/ios/ReactCodegen"
    mkdir -p "$dir"
    touch \
        "$dir/RCTModuleProviders.h" \
        "$dir/RCTModuleProviders.mm" \
        "$dir/RCTThirdPartyComponentsProvider.h" \
        "$dir/RCTThirdPartyComponentsProvider.mm" \
        "$dir/RCTModulesConformingToProtocolsProvider.h" \
        "$dir/RCTModulesConformingToProtocolsProvider.mm" \
        "$dir/RCTUnstableModulesRequiringMainQueueSetupProvider.h" \
        "$dir/RCTUnstableModulesRequiringMainQueueSetupProvider.mm"
}

project_has_sandbox_config() {
    local sandbox="$1"
    local macro=""

    case "$sandbox" in
        jsc) macro="RILL_SANDBOX_JSC=1" ;;
        hermes) macro="RILL_SANDBOX_HERMES=1" ;;
        quickjs) macro="RILL_SANDBOX_QUICKJS=1" ;;
        *) return 1 ;;
    esac

    grep -q "\"$macro\"" ios-demo.xcodeproj/project.pbxproj 2>/dev/null
}

# Boot simulator
BOOT_STATE=$(xcrun simctl list devices | grep "$DEVICE_ID" | grep -o "(Booted)" || true)
if [ -z "$BOOT_STATE" ]; then
    echo "Booting simulator..."
    xcrun simctl boot "$DEVICE_ID" 2>/dev/null || true
fi
open -a Simulator --args -CurrentDeviceUDID "$DEVICE_ID"

# Track success/failure
SUCCESSFUL=()
FAILED=()

for CONFIG in "${CONFIGS_TO_INSTALL[@]}"; do
    # Parse config into mode and sandbox
    MODE="bridgeless"
    SANDBOX=$(echo "$CONFIG" | cut -d'-' -f2)

    # Format display names
    case "$SANDBOX" in
        jsc) SANDBOX_DISPLAY="JSC" ;;
        hermes) SANDBOX_DISPLAY="Hermes" ;;
        quickjs) SANDBOX_DISPLAY="QuickJS" ;;
    esac

    BUNDLE_ID="${BASE_BUNDLE_ID}.${MODE}.${SANDBOX}"
    APP_DISPLAY_NAME="rill-Bridgeless-${SANDBOX_DISPLAY}"
    SCHEME="ios-demo (Bridgeless+${SANDBOX_DISPLAY})"
    BUILD_DIR="$HOME/Library/Developer/Xcode/DerivedData/ios-demo-${MODE}-${SANDBOX}"

    echo "========================================"
    echo "[${CONFIG}] Building..."
    echo "  Scheme: $SCHEME"
    echo "  Bundle ID: $BUNDLE_ID"
    echo "========================================"

    ensure_codegen_placeholders

    # Switch configuration (pod install) — skip if cached for this sandbox engine
    CACHE_FILE=".rill_pod_cache"
    CURRENT_KEY="${SANDBOX}"
    if [ -f "$CACHE_FILE" ] && [ "$(cat "$CACHE_FILE")" = "$CURRENT_KEY" ] && [ -d "Pods" ] && project_has_sandbox_config "$SANDBOX"; then
        echo "[${CONFIG}] Pods cached for $SANDBOX, skipping pod install"
    else
        echo "[${CONFIG}] Configuring pods..."
        POD_LOG="/tmp/ios-demo-pods-${MODE}-${SANDBOX}.log"
        if [ "$VERBOSE" -eq 1 ]; then
            POD_CMD=(pod install)
            if ! (RILL_SANDBOX=$SANDBOX "${POD_CMD[@]}" 2>&1 | tee "$POD_LOG"); then
                FAILED+=("$CONFIG")
                echo "[${CONFIG}] Pod install failed (see $POD_LOG)"
                echo ""
                continue
            fi
        else
            if ! (RILL_SANDBOX=$SANDBOX pod install >"$POD_LOG" 2>&1); then
                FAILED+=("$CONFIG")
                echo "[${CONFIG}] Pod install failed (see $POD_LOG)"
                tail -n 40 "$POD_LOG" || true
                echo ""
                continue
            fi
            echo "[${CONFIG}] Pods OK (log: $POD_LOG)"
        fi
        echo "$CURRENT_KEY" > "$CACHE_FILE"
    fi

    if [ ! -d "ios-demo.xcworkspace" ]; then
        FAILED+=("$CONFIG")
        echo "[${CONFIG}] Pod install did not generate ios-demo.xcworkspace (see $POD_LOG)"
        if [ "$VERBOSE" -eq 0 ]; then
            tail -n 60 "$POD_LOG" || true
        fi
        echo ""
        continue
    fi

    # Build
    echo "[${CONFIG}] Building ($VARIANT)..."
    BUILD_LOG="/tmp/ios-demo-build-${MODE}-${SANDBOX}.log"
    APP_PATH="$BUILD_DIR/Build/Products/${VARIANT_CAP}-iphonesimulator/ios-demo.app"

    XCODEBUILD_ARGS=(
        -workspace "ios-demo.xcworkspace"
        -scheme "$SCHEME"
        -configuration "$VARIANT_CAP"
        -destination "platform=iOS Simulator,id=$DEVICE_ID,arch=arm64"
        -derivedDataPath "$BUILD_DIR"
        build
    )

    if [ "$VERBOSE" -eq 1 ]; then
        if ! (xcodebuild "${XCODEBUILD_ARGS[@]}" 2>&1 | tee "$BUILD_LOG"); then
            FAILED+=("$CONFIG")
            echo "[${CONFIG}] Build failed (see $BUILD_LOG)"
            echo ""
            continue
        fi
    else
        if ! (xcodebuild -quiet "${XCODEBUILD_ARGS[@]}" >"$BUILD_LOG" 2>&1); then
            FAILED+=("$CONFIG")
            echo "[${CONFIG}] Build failed (see $BUILD_LOG)"
            tail -n 80 "$BUILD_LOG" || true
            echo ""
            continue
        fi
        echo "[${CONFIG}] Build OK (log: $BUILD_LOG)"
    fi

    # Check if build succeeded by verifying app exists
    if [ -d "$APP_PATH" ]; then
        # Update Info.plist with unique bundle ID and display name
        /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP_PATH/Info.plist"
        /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_DISPLAY_NAME" "$APP_PATH/Info.plist" 2>/dev/null || \
            /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_DISPLAY_NAME" "$APP_PATH/Info.plist"
        /usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_DISPLAY_NAME" "$APP_PATH/Info.plist"

        # Bundle JavaScript (no watchman needed for static builds)
        echo "[${CONFIG}] Bundling JS..."
        BUNDLE_OUTPUT="$APP_PATH/main.jsbundle"
        # Clear watchman watches to avoid recrawl warnings
        watchman watch-del-all >/dev/null 2>&1 || true
        BUNDLE_CMD=(node node_modules/react-native/cli.js bundle
                --entry-file index.tsx
                --platform ios
                --dev false
                --bundle-output "$BUNDLE_OUTPUT"
                --assets-dest "$APP_PATH"
                --minify false)
        BUNDLE_LOG="/tmp/ios-demo-bundle-${MODE}-${SANDBOX}.log"
        if [ "$VERBOSE" -eq 1 ]; then
            if ! ("${BUNDLE_CMD[@]}" 2>&1 | tee "$BUNDLE_LOG"); then
                FAILED+=("$CONFIG")
                echo "[${CONFIG}] JS bundle failed (see $BUNDLE_LOG)"
                echo ""
                continue
            fi
        else
            if ! ("${BUNDLE_CMD[@]}" >"$BUNDLE_LOG" 2>&1); then
                FAILED+=("$CONFIG")
                echo "[${CONFIG}] JS bundle failed (see $BUNDLE_LOG)"
                tail -n 20 "$BUNDLE_LOG" || true
                echo ""
                continue
            fi
        fi

        # Copy test source code to app bundle (for all engines)
        TESTCODE_DIR="$(pwd)/TestCode"
        if [ -d "$TESTCODE_DIR" ]; then
            cp -r "$TESTCODE_DIR" "$APP_PATH/"
        fi

        # For Hermes: compile JS to bytecode (AOT)
        if [ "$SANDBOX" = "hermes" ]; then
            echo "[${CONFIG}] Compiling to Hermes bytecode (AOT)..."
            HERMESC="$(pwd)/Pods/hermes-engine/destroot/bin/hermesc"
            if [ -f "$HERMESC" ]; then
                # -w suppresses warnings about RN runtime globals (setTimeout, Promise, etc.)
                # These are provided by the RN runtime at execution time
                "$HERMESC" -emit-binary -O -w -out "$BUNDLE_OUTPUT" "$BUNDLE_OUTPUT"
                echo "[${CONFIG}] Hermes bytecode generated"

                # Compile test code to bytecode for AOT benchmarks
                echo "[${CONFIG}] Compiling test bytecode..."
                TESTCODE_DIR="$(pwd)/TestCode"
                BYTECODE_DIR="$APP_PATH/TestBytecode"
                mkdir -p "$BYTECODE_DIR"
                for JS_FILE in "$TESTCODE_DIR"/*.js; do
                    BASENAME=$(basename "$JS_FILE" .js)
                    "$HERMESC" -emit-binary -O -w -out "$BYTECODE_DIR/${BASENAME}.hbc" "$JS_FILE" 2>/dev/null
                done
                echo "[${CONFIG}] Test bytecode compiled"
            else
                echo "[${CONFIG}] Warning: hermesc not found, skipping AOT compilation"
            fi
        fi

        # Re-sign after modifications
        codesign --force --sign - "$APP_PATH" 2>/dev/null || true

        # Install
        echo "[${CONFIG}] Installing..."
        if xcrun simctl install "$DEVICE_ID" "$APP_PATH"; then
            SUCCESSFUL+=("$CONFIG")
            echo "[${CONFIG}] Installed successfully"
        else
            FAILED+=("$CONFIG")
            echo "[${CONFIG}] Install failed"
        fi
    else
        FAILED+=("$CONFIG")
        echo "[${CONFIG}] Build output not found at $APP_PATH (see $BUILD_LOG)"
        if [ "$VERBOSE" -eq 0 ]; then
            tail -n 80 "$BUILD_LOG" || true
        fi
    fi
    echo ""
done

echo "========================================"
echo "Installation Complete"
echo "========================================"

if [ ${#SUCCESSFUL[@]} -gt 0 ]; then
    echo ""
    echo "Installed (${#SUCCESSFUL[@]}):"
    for s in "${SUCCESSFUL[@]}"; do
        echo "  - $s"
    done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
    echo ""
    echo "Failed (${#FAILED[@]}):"
    for f in "${FAILED[@]}"; do
        echo "  - $f"
    done
    exit 1
fi

echo ""
echo "Each app has a unique name showing its configuration."
echo "========================================"
