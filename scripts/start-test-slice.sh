#!/bin/bash
# start-test-slice.sh — bring up isolated test slice alongside legacy stack.
# Creates: emulator-test1 + audio-capture-mgr-test1, sharing pulse-hub
# and devicehub network with the legacy stack. Uses emu_audio_2/emu_mic_2
# (slot 2 of pulse-hub, slot 1 occupied by legacy emulator-1).

set -euo pipefail

readonly DOCKER_NETWORK="devicehub_devicehub"
readonly PULSE_VOLUME="devicehub_pulse-sock"
readonly BACKUPS_DIR="$HOME/caller/devicehub-backups"

readonly INSTANCE_SERIAL="emulator-test1:5555"
readonly EMULATOR_NAME="emulator-test1"
readonly CAPTURE_NAME="audio-capture-mgr-test1"
readonly PULSE_SINK="emu_audio_2"
readonly PULSE_SOURCE="emu_mic_2"
readonly V4L2_HOST_DEVICE="/dev/video21"

readonly MANAGER_PORT="7601"
readonly ADB_PORT="5557"
readonly VNC_PORT="6081"

readonly WEBRTC_PORT_MIN="40020"
readonly WEBRTC_PORT_MAX="40030"

readonly EMULATOR_IMAGE="budtmo/docker-android:emulator_13.0"
readonly CAPTURE_IMAGE="audio-capture-mgr"

mkdir -p "$BACKUPS_DIR"
chmod 777 "$BACKUPS_DIR" 2>/dev/null || true

echo "[test-slice] Preflight..."
./scripts/host-setup.sh || { echo "[test-slice] Host preflight failed — fix and retry"; exit 1; }

echo "[test-slice] Stopping any previous test slice containers..."
docker stop "$EMULATOR_NAME" "$CAPTURE_NAME" 2>/dev/null || true
docker rm   "$EMULATOR_NAME" "$CAPTURE_NAME" 2>/dev/null || true

echo "[test-slice] Starting capture-mgr-test1 first (camera writer must be up before emulator)..."
docker run -d \
    --name "$CAPTURE_NAME" \
    --network "$DOCKER_NETWORK" \
    --group-add video \
    -e MANAGER_PORT="$MANAGER_PORT" \
    -e PA_SERVER="unix:/run/pulse/shared.sock" \
    -e INSTANCE_SERIAL="$INSTANCE_SERIAL" \
    -e PULSE_SINK_NAME="$PULSE_SINK" \
    -e PULSE_SOURCE_NAME="$PULSE_SOURCE" \
    -e EMULATOR_ADB_HOST="$EMULATOR_NAME" \
    -e EMULATOR_GRPC_HOST="$EMULATOR_NAME" \
    -e CAMERA_V4L2_DEVICE="/dev/video0" \
    -e BACKUP_DIR="/backups" \
    -e LOG_PRETTY="${LOG_PRETTY:-1}" \
    -v "$PULSE_VOLUME:/run/pulse" \
    -v "$BACKUPS_DIR:/backups" \
    --device "$V4L2_HOST_DEVICE:/dev/video0" \
    -p "${MANAGER_PORT}:${MANAGER_PORT}" \
    -e WEBRTC_PORT_MIN="$WEBRTC_PORT_MIN" \
    -e WEBRTC_PORT_MAX="$WEBRTC_PORT_MAX" \
    -p "${WEBRTC_PORT_MIN}-${WEBRTC_PORT_MAX}:${WEBRTC_PORT_MIN}-${WEBRTC_PORT_MAX}/udp" \
    --restart unless-stopped \
    "$CAPTURE_IMAGE"

echo "[test-slice] Waiting for capture-mgr-test1 to settle..."
sleep 5

if ! docker ps --filter "name=$CAPTURE_NAME" --format '{{.Status}}' | grep -q "^Up"; then
    echo "[test-slice] ERROR: $CAPTURE_NAME not running. Logs:"
    docker logs "$CAPTURE_NAME" 2>&1 | tail -30
    exit 1
fi

echo "[test-slice] $CAPTURE_NAME startup logs (last 25 lines):"
docker logs "$CAPTURE_NAME" 2>&1 | tail -25

echo "[test-slice] Starting $EMULATOR_NAME..."
docker run -d \
    --name "$EMULATOR_NAME" \
    --hostname "$EMULATOR_NAME" \
    --network "$DOCKER_NETWORK" \
    --device /dev/kvm \
    --device "$V4L2_HOST_DEVICE:/dev/video0" \
    --group-add video \
    -e EMULATOR_DEVICE="Samsung Galaxy S10" \
    -e WEB_VNC=true \
    -e PULSE_SERVER="unix:/run/pulse/shared.sock" \
    -e PULSE_SINK="$PULSE_SINK" \
    -e PULSE_SOURCE="$PULSE_SOURCE" \
    -e QEMU_AUDIO_DRV=pa \
    -e EMULATOR_ADDITIONAL_ARGS="-allow-host-audio -grpc 8554 -camera-front webcam0" \
    -v "$PULSE_VOLUME:/run/pulse" \
    -p "${VNC_PORT}:6080" \
    -p "${ADB_PORT}:5555" \
    --restart unless-stopped \
    "$EMULATOR_IMAGE"

echo "[test-slice] Waiting for emulator boot (up to 2 minutes)..."
for i in $(seq 1 24); do
    if docker exec "$EMULATOR_NAME" adb shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
        echo "[test-slice] Emulator boot completed!"
        break
    fi
    echo "[test-slice] ... still booting ($((i*5))s elapsed)"
    sleep 5
done

echo "[test-slice] Connecting adbd to $EMULATOR_NAME..."
docker compose -f docker-compose-prod.yaml --env-file scripts/variables.env exec -T adbd adb connect "${EMULATOR_NAME}" 2>&1 || \
    echo "[test-slice] WARN: adb connect failed — emulator may not appear in DeviceHub UI"

echo "[test-slice] Restarting devicehub-provider so it picks up the new emulator..."
docker restart devicehub-provider 2>/dev/null || echo "[test-slice] (devicehub-provider not running — skipped)"

# Provider needs a moment to register the device after restart
sleep 3

echo "[test-slice] Test slice ready:"
echo "  Capture logs:  docker logs -f $CAPTURE_NAME"
echo "  Emulator logs: docker logs -f $EMULATOR_NAME"
echo "  Emulator VNC:  http://localhost:${VNC_PORT}/"
echo "  Manager API:   http://localhost:${MANAGER_PORT}/api/health"
echo "  ADB:           adb connect localhost:${ADB_PORT}"
