#!/bin/bash
# Android Emulator E2E runner for android-demo.
# Builds, installs, launches, and parses real emulator/device runs for each sandbox.

set -euo pipefail

cd "$(dirname "$0")"

BASE_PACKAGE_ID="com.rill.demo"
VALID_CONFIGS=("quickjs" "hermes")
CONFIGS_TO_RUN=()
VARIANT="release"
TIMEOUT_SECONDS="${RILL_ANDROID_E2E_TIMEOUT:-120}"
BOOT_TIMEOUT_SECONDS="${RILL_ANDROID_E2E_BOOT_TIMEOUT:-180}"
HEADLESS="${RILL_ANDROID_E2E_HEADLESS:-1}"
ADB_BIN="${ADB:-adb}"
EMULATOR_BIN="${EMULATOR:-emulator}"
DEVICE_SERIAL=""
STARTED_EMULATOR=0

if [ -z "${ANDROID_HOME:-}" ]; then
    if [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    elif [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    fi
fi

if [ -n "${ANDROID_HOME:-}" ]; then
    for dir in "$ANDROID_HOME/platform-tools" "$ANDROID_HOME/emulator" "$ANDROID_HOME/cmdline-tools/latest/bin"; do
        if [ -d "$dir" ] && [[ ":$PATH:" != *":$dir:"* ]]; then
            export PATH="$dir:$PATH"
        fi
    done
fi

show_usage() {
    echo ""
    echo "Usage:"
    echo "  ./run-e2e.sh                    # Run quickjs + hermes release E2E"
    echo "  ./run-e2e.sh quickjs            # Run QuickJS only"
    echo "  ./run-e2e.sh hermes             # Run Hermes only"
    echo "  ./run-e2e.sh --debug            # Run debug variants"
    echo ""
    echo "Environment:"
    echo "  RILL_ANDROID_E2E_DEVICE=<serial>       Target adb device serial"
    echo "  RILL_ANDROID_E2E_AVD=<name>            AVD to start when no device is connected"
    echo "  RILL_ANDROID_E2E_HEADLESS=0            Show emulator window when runner starts it"
    echo "  RILL_ANDROID_E2E_TIMEOUT=<seconds>     Marker wait timeout (default: 120)"
    echo "  RILL_ANDROID_GRADLE_INIT=<path>        Extra Gradle init script for install.sh"
    echo "  RILL_ANDROID_GRADLE_ARGS='<flags>'     Extra Gradle flags for install.sh"
}

is_valid_config() {
    local config="$1"
    for valid in "${VALID_CONFIGS[@]}"; do
        if [ "$config" = "$valid" ]; then
            return 0
        fi
    done
    return 1
}

while [ $# -gt 0 ]; do
    case "$1" in
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
            CONFIGS_TO_RUN+=("$1")
            shift
            ;;
        *)
            echo "Invalid argument: $1"
            show_usage
            exit 1
            ;;
    esac
done

if [ ${#CONFIGS_TO_RUN[@]} -eq 0 ]; then
    CONFIGS_TO_RUN=("${VALID_CONFIGS[@]}")
fi

adb_cmd() {
    if [ -n "$DEVICE_SERIAL" ]; then
        "$ADB_BIN" -s "$DEVICE_SERIAL" "$@"
    else
        "$ADB_BIN" "$@"
    fi
}

select_device() {
    if [ -n "${RILL_ANDROID_E2E_DEVICE:-}" ]; then
        echo "$RILL_ANDROID_E2E_DEVICE"
        return 0
    fi

    "$ADB_BIN" devices | awk '$2 == "device" { print $1; exit }'
}

select_avd() {
    if [ -n "${RILL_ANDROID_E2E_AVD:-}" ]; then
        echo "$RILL_ANDROID_E2E_AVD"
        return 0
    fi

    local avds
    avds="$("$EMULATOR_BIN" -list-avds 2>/dev/null | grep -v -E '^(INFO|WARNING|ERROR)\s' || true)"
    local avd
    avd="$(echo "$avds" | grep -v -i -E 'tv|wear|auto|car' | head -1 || true)"
    if [ -z "$avd" ]; then
        avd="$(echo "$avds" | head -1 || true)"
    fi
    echo "$avd"
}

wait_for_boot() {
    local deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))

    adb_cmd wait-for-device
    while [ $SECONDS -lt $deadline ]; do
        if [ "$(adb_cmd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
            adb_cmd shell input keyevent 82 >/dev/null 2>&1 || true
            return 0
        fi
        sleep 1
    done

    echo "Timed out after ${BOOT_TIMEOUT_SECONDS}s waiting for Android boot" >&2
    return 1
}

launch_emulator_if_needed() {
    DEVICE_SERIAL="$(select_device)"
    if [ -n "$DEVICE_SERIAL" ]; then
        return 0
    fi

    if ! command -v "$EMULATOR_BIN" >/dev/null 2>&1; then
        echo "No Android device connected and emulator command was not found." >&2
        return 1
    fi

    local avd
    avd="$(select_avd)"
    if [ -z "$avd" ]; then
        echo "No Android device connected and no AVDs were found." >&2
        return 1
    fi

    echo "No device connected. Launching emulator: $avd"
    local flags=("-avd" "$avd" "-no-snapshot-load")
    if [ "$HEADLESS" != "0" ]; then
        flags+=("-no-window" "-gpu" "swiftshader_indirect" "-no-audio" "-no-boot-anim")
    fi

    "$EMULATOR_BIN" "${flags[@]}" >/tmp/rill-android-e2e-emulator.log 2>&1 &
    STARTED_EMULATOR=1

    sleep 2
    DEVICE_SERIAL="$(select_device)"
    if [ -z "$DEVICE_SERIAL" ]; then
        "$ADB_BIN" wait-for-device
        DEVICE_SERIAL="$(select_device)"
    fi

    if [ -z "$DEVICE_SERIAL" ]; then
        echo "Emulator started but adb did not report a device." >&2
        return 1
    fi
}

cleanup() {
    if [ "$STARTED_EMULATOR" = "1" ] && [ "${RILL_ANDROID_E2E_KEEP_EMULATOR:-0}" != "1" ]; then
        adb_cmd emu kill >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

wait_for_result() {
    local log_file="$1"
    local deadline=$((SECONDS + TIMEOUT_SECONDS))

    while [ $SECONDS -lt $deadline ]; do
        adb_cmd logcat -d -v time >"$log_file.tmp" 2>/dev/null || true
        mv "$log_file.tmp" "$log_file"

        if grep -q ">>>RILL_ANDROID_E2E_END<<<" "$log_file" 2>/dev/null; then
            if grep -q "EXIT_CODE:0" "$log_file"; then
                return 0
            fi
            if grep -q "EXIT_CODE:1" "$log_file"; then
                return 1
            fi
        fi

        if grep -q -E "FATAL EXCEPTION|AndroidRuntime" "$log_file" 2>/dev/null; then
            return 1
        fi

        sleep 1
    done

    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for Android E2E markers" >&2
    return 1
}

print_relevant_logs() {
    local log_file="$1"

    grep -E "RILL_ANDROID_E2E|EXIT_CODE|Summary:|RillSandboxNative|RillPerformanceBridge|ReactNativeJS|FATAL EXCEPTION|AndroidRuntime" \
        "$log_file" | tail -160 || true
}

if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
    echo "adb command was not found." >&2
    exit 1
fi

launch_emulator_if_needed
wait_for_boot

echo "========================================"
echo "android-demo Android Emulator E2E"
echo "========================================"
echo "Device: $DEVICE_SERIAL"
echo "Variant: $VARIANT"
echo "Flavors: ${CONFIGS_TO_RUN[*]}"
echo ""

FAILED=()
PASSED=()

for CONFIG in "${CONFIGS_TO_RUN[@]}"; do
    if ! is_valid_config "$CONFIG"; then
        echo "Invalid config: $CONFIG"
        exit 1
    fi

    PACKAGE_ID="${BASE_PACKAGE_ID}.${CONFIG}"
    LOG_FILE="/tmp/rill-android-e2e-${CONFIG}.log"

    echo "========================================"
    echo "[$CONFIG] build + install"
    echo "========================================"
    if ! ANDROID_SERIAL="$DEVICE_SERIAL" ./install.sh "$CONFIG" "--$VARIANT"; then
        echo "[$CONFIG] install failed"
        FAILED+=("$CONFIG")
        continue
    fi

    rm -f "$LOG_FILE" "$LOG_FILE.tmp" "/tmp/rill-android-e2e-launch-${CONFIG}.log"
    adb_cmd logcat -c
    adb_cmd shell am force-stop "$PACKAGE_ID" >/dev/null 2>&1 || true

    echo "[$CONFIG] launch + verify"
    if ! adb_cmd shell am start \
        -S \
        -n "$PACKAGE_ID/com.rill.demo.MainActivity" \
        --ez rillE2E true \
        --es rillSandbox "$CONFIG" \
        >"/tmp/rill-android-e2e-launch-${CONFIG}.log" 2>&1; then
        echo "[$CONFIG] launch failed"
        cat "/tmp/rill-android-e2e-launch-${CONFIG}.log" || true
        FAILED+=("$CONFIG")
        continue
    fi

    if wait_for_result "$LOG_FILE"; then
        echo "[$CONFIG] passed"
        PASSED+=("$CONFIG")
    else
        echo "[$CONFIG] failed"
        echo "Log: $LOG_FILE"
        print_relevant_logs "$LOG_FILE"
        FAILED+=("$CONFIG")
    fi

    adb_cmd shell am force-stop "$PACKAGE_ID" >/dev/null 2>&1 || true
    echo ""
done

echo "========================================"
echo "Android Emulator E2E Summary"
echo "========================================"
echo "Passed (${#PASSED[@]}): ${PASSED[*]:-none}"
echo "Failed (${#FAILED[@]}): ${FAILED[*]:-none}"

if [ ${#FAILED[@]} -gt 0 ]; then
    exit 1
fi

exit 0
