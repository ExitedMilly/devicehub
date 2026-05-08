#!/bin/bash
# stop-test-slice.sh — tear down test slice without touching legacy stack.
# Stops and removes emulator-test1 and audio-capture-mgr-test1 containers.
# Pulse-hub, devicehub-* containers and emulator-1 are NOT affected.

set -uo pipefail

readonly EMULATOR_NAME="emulator-test1"
readonly CAPTURE_NAME="audio-capture-mgr-test1"

echo "[test-slice] Stopping test slice containers..."

# Stop in reverse startup order (emulator first, then capture-mgr)
for c in "$EMULATOR_NAME" "$CAPTURE_NAME"; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${c}$"; then
        echo "[test-slice] Removing $c"
        docker stop "$c" >/dev/null 2>&1 || true
        docker rm   "$c" >/dev/null 2>&1 || true
    else
        echo "[test-slice] $c not found, skipping"
    fi
done

# Optionally disconnect adb to clean up DeviceHub provider state
if docker ps --format '{{.Names}}' | grep -q '^adbd$'; then
    echo "[test-slice] Disconnecting adb from $EMULATOR_NAME..."
    docker compose -f docker-compose-prod.yaml --env-file scripts/variables.env exec -T adbd \
        adb disconnect "${EMULATOR_NAME}:5555" 2>/dev/null || true
fi

echo "[test-slice] Done. Legacy stack (emulator-1, audio-capture-mgr) is unaffected."
