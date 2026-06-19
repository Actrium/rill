#!/bin/bash
# iOS Simulator E2E runner for ios-demo.
# Builds, installs, launches, and parses real simulator runs for each sandbox.

set -euo pipefail

cd "$(dirname "$0")"

BASE_BUNDLE_ID="chat.askaway.ios-demo"
VALID_CONFIGS=("bridgeless-jsc" "bridgeless-quickjs" "bridgeless-hermes")
CONFIGS_TO_RUN=()
TIMEOUT_SECONDS="${RILL_IOS_E2E_TIMEOUT:-120}"
SIMULATOR_NAME="${RILL_IOS_E2E_SIMULATOR:-${SIMULATOR:-iPhone 17}}"
LOG_PREDICATE='process == "ios-demo" AND (eventMessage CONTAINS "RILL_IOS_E2E" OR eventMessage CONTAINS "EXIT_CODE:" OR eventMessage BEGINSWITH "Summary:")'

is_valid_config() {
    local config="$1"
    for valid in "${VALID_CONFIGS[@]}"; do
        if [ "$config" = "$valid" ]; then
            return 0
        fi
    done
    return 1
}

for arg in "$@"; do
    if is_valid_config "$arg"; then
        CONFIGS_TO_RUN+=("$arg")
    else
        echo "Invalid config: $arg"
        echo "Valid configs: ${VALID_CONFIGS[*]}"
        exit 1
    fi
done

if [ ${#CONFIGS_TO_RUN[@]} -eq 0 ]; then
    CONFIGS_TO_RUN=("${VALID_CONFIGS[@]}")
fi

select_device() {
    if [ -n "${RILL_IOS_E2E_DEVICE_ID:-}" ]; then
        echo "$RILL_IOS_E2E_DEVICE_ID"
        return 0
    fi

    local device_id=""
    device_id="$(xcrun simctl list devices available | grep "$SIMULATOR_NAME" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/' || true)"
    if [ -z "$device_id" ]; then
        device_id="$(xcrun simctl list devices available | grep "(Booted)" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/' || true)"
    fi
    if [ -z "$device_id" ]; then
        device_id="$(xcrun simctl list devices available | grep "iPhone" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/' || true)"
    fi
    if [ -z "$device_id" ]; then
        device_id="$(xcrun simctl list devices available | grep "iPad" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/' || true)"
    fi

    if [ -z "$device_id" ]; then
        echo "No available iOS simulator found" >&2
        return 1
    fi

    echo "$device_id"
}

device_name() {
    xcrun simctl list devices available | grep "$1" | head -1 | sed -E 's/^[[:space:]]*//' | sed -E 's/[[:space:]]+\([A-F0-9-]+\).*//' | xargs
}

wait_for_result() {
    local log_file="$1"
    local deadline=$((SECONDS + TIMEOUT_SECONDS))

    while [ $SECONDS -lt $deadline ]; do
        if grep -q ">>>RILL_IOS_E2E_END<<<" "$log_file" 2>/dev/null; then
            if grep -q "EXIT_CODE:0" "$log_file"; then
                return 0
            fi
            if grep -q "EXIT_CODE:1" "$log_file"; then
                return 1
            fi
        fi
        sleep 1
    done

    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for iOS E2E markers" >&2
    return 1
}

has_success_result() {
    local log_file="$1"

    grep -q ">>>RILL_IOS_E2E_END<<<" "$log_file" 2>/dev/null &&
        grep -q "EXIT_CODE:0" "$log_file"
}

start_log_stream() {
    local device_id="$1"
    local log_file="$2"

    xcrun simctl spawn "$device_id" log stream \
        --style compact \
        --level debug \
        --predicate "$LOG_PREDICATE" >"$log_file" 2>&1 &
    LOG_STREAM_PID=$!
}

stop_log_stream() {
    local pid="$1"

    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
        wait "$pid" 2>/dev/null || true
    fi
}

append_recent_logs() {
    local device_id="$1"
    local log_file="$2"

    xcrun simctl spawn "$device_id" log show \
        --last 2m \
        --style compact \
        --predicate "$LOG_PREDICATE" >>"$log_file" 2>&1 || true
}

DEVICE_ID="$(select_device)"
DEVICE_NAME="$(device_name "$DEVICE_ID")"
if [ -z "$DEVICE_NAME" ]; then
    echo "Could not resolve simulator name for $DEVICE_ID" >&2
    exit 1
fi

if ! xcrun simctl list devices | grep "$DEVICE_ID" | grep -q "(Booted)"; then
    echo "Booting simulator: $DEVICE_NAME ($DEVICE_ID)"
    xcrun simctl boot "$DEVICE_ID" 2>/dev/null || true
fi
open -a Simulator --args -CurrentDeviceUDID "$DEVICE_ID" >/dev/null 2>&1 || true

echo "========================================"
echo "ios-demo iOS Simulator E2E"
echo "========================================"
echo "Simulator: $DEVICE_NAME ($DEVICE_ID)"
echo "Configs: ${CONFIGS_TO_RUN[*]}"
echo ""

FAILED=()
PASSED=()

for CONFIG in "${CONFIGS_TO_RUN[@]}"; do
    SANDBOX="${CONFIG#bridgeless-}"
    BUNDLE_ID="${BASE_BUNDLE_ID}.bridgeless.${SANDBOX}"
    LOG_FILE="/tmp/rill-ios-e2e-${SANDBOX}.log"

    echo "========================================"
    echo "[$CONFIG] build + install"
    echo "========================================"
    if ! SIMULATOR="$DEVICE_NAME" ./install.sh "$CONFIG" --release; then
        echo "[$CONFIG] install failed"
        FAILED+=("$CONFIG")
        continue
    fi

    rm -f "$LOG_FILE" "${LOG_FILE}.stdout" "${LOG_FILE}.stderr"
    xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true

    echo "[$CONFIG] launch + verify"
    LOG_STREAM_PID=""
    start_log_stream "$DEVICE_ID" "$LOG_FILE"
    sleep 1

    if ! SIMCTL_CHILD_RILL_IOS_E2E=1 \
        SIMCTL_CHILD_RILL_SANDBOX_TARGET="$SANDBOX" \
        xcrun simctl launch \
        --terminate-running-process \
        --stdout="${LOG_FILE}.stdout" \
        --stderr="${LOG_FILE}.stderr" \
        "$DEVICE_ID" \
        "$BUNDLE_ID" >/tmp/rill-ios-e2e-launch-${SANDBOX}.log 2>&1; then
        echo "[$CONFIG] launch failed"
        cat /tmp/rill-ios-e2e-launch-${SANDBOX}.log || true
        stop_log_stream "$LOG_STREAM_PID"
        FAILED+=("$CONFIG")
        continue
    fi

    if wait_for_result "$LOG_FILE"; then
        echo "[$CONFIG] passed"
        PASSED+=("$CONFIG")
    else
        append_recent_logs "$DEVICE_ID" "$LOG_FILE"
        if has_success_result "$LOG_FILE"; then
            echo "[$CONFIG] passed"
            PASSED+=("$CONFIG")
            stop_log_stream "$LOG_STREAM_PID"
            xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
            echo ""
            continue
        fi
        echo "[$CONFIG] failed"
        echo "Log: $LOG_FILE"
        tail -120 "$LOG_FILE" || true
        FAILED+=("$CONFIG")
    fi

    stop_log_stream "$LOG_STREAM_PID"
    xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    echo ""
done

echo "========================================"
echo "iOS Simulator E2E Summary"
echo "========================================"
echo "Passed (${#PASSED[@]}): ${PASSED[*]:-none}"
echo "Failed (${#FAILED[@]}): ${FAILED[*]:-none}"

if [ ${#FAILED[@]} -gt 0 ]; then
    exit 1
fi

exit 0
