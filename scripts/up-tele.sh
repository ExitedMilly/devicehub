#!/bin/bash
# up-tele.sh — STANDALONE throwaway instance for telephony console-transport testing.
#
# NOT generated from instances.yaml; run by hand. Fully isolated from test1 / prod:
# distinct names, ports, pulse slot, v4l2 device and WebRTC range (zero collision).
#
# Two things this adds vs the normal slice:
#   1. Mounts ONE shared console auth-token file into BOTH the emulator and the
#      capture-mgr, so the manager can drive the emulator console (telnet :5554)
#      — the transport telephony needs (gsm/network/roaming have no shell/gRPC path).
#   2. AUTH_REQUIRED=0 so the HTTP API can be hit with plain curl (no JWT minting).
#      NOTE: the *console* token is separate from this and is always required for
#      the console itself — that's exactly what we're wiring here.
#
# Prereqs: prod stack + pulse-hub up (network `devicehub_devicehub` and pulse exist),
# and the `audio-capture-mgr` image already built.

set -uo pipefail   # deliberately NO -e: audio/health may be degraded and that's fine here

readonly EMULATOR_NAME="emulator-tele"
readonly CAPTURE_NAME="audio-capture-mgr-tele"
readonly TOKEN_FILE="$HOME/caller/console-tokens/${EMULATOR_NAME}"

# ---- console auth-token (our value, stable across restarts) ----------------
mkdir -p "$(dirname "$TOKEN_FILE")"
if [ ! -s "$TOKEN_FILE" ]; then
    printf '%s' "$(openssl rand -hex 8)" > "$TOKEN_FILE"
fi
chmod 666 "$TOKEN_FILE"
echo "[tele] console token: $(cat "$TOKEN_FILE")   (file: $TOKEN_FILE)"

# ---- clean any previous tele containers ------------------------------------
docker stop "$EMULATOR_NAME" "$CAPTURE_NAME" 2>/dev/null || true
docker rm   "$EMULATOR_NAME" "$CAPTURE_NAME" 2>/dev/null || true

mkdir -p "/home/ivan/devicehub-backups"
chmod 777 "/home/ivan/devicehub-backups" 2>/dev/null || true

# ---- heads-up if the audio sink for slot 3 isn't loaded (audio only) -------
if ! docker exec pulse-hub pactl list short sinks 2>/dev/null | grep -q 'emu_audio_3'; then
    echo "[tele] NOTE: pulse sink 'emu_audio_3' not found — audio for this instance will be degraded."
    echo "[tele]       Irrelevant for telephony (HTTP + console work regardless). Continuing."
fi

echo "[tele] Starting capture-mgr (AUTH_REQUIRED=0, console token mounted at /run/console-token)..."
docker run -d \
    --name "$CAPTURE_NAME" \
    --network "devicehub_devicehub" \
    --group-add video \
    -e MANAGER_PORT="7602" \
    -e PA_SERVER="unix:/run/pulse/shared.sock" \
    -e INSTANCE_SERIAL="${EMULATOR_NAME}:5555" \
    -e PULSE_SINK_NAME="emu_audio_3" \
    -e PULSE_SOURCE_NAME="emu_mic_3" \
    -e EMULATOR_ADB_HOST="$EMULATOR_NAME" \
    -e EMULATOR_GRPC_HOST="$EMULATOR_NAME" \
    -e CAMERA_V4L2_DEVICE="/dev/video0" \
    -e WEBRTC_PORT_MIN="40040" \
    -e WEBRTC_PORT_MAX="40050" \
    -e BACKUP_DIR="/backups" \
    -e LOG_PRETTY="1" \
    -e STF_SECRET="nosecret" \
    -e AUTH_REQUIRED="0" \
    -v "devicehub_pulse-sock:/run/pulse" \
    -v "/home/ivan/devicehub-backups:/backups" \
    -v "${TOKEN_FILE}:/run/console-token:ro" \
    --device "/dev/video22:/dev/video0" \
    -p "7602:7602" \
    -p "40040-40050:40040-40050/udp" \
    --restart unless-stopped \
    "audio-capture-mgr"

echo "[tele] Waiting for capture-mgr health (non-fatal — we need HTTP+console, not audio)..."
for i in $(seq 1 30); do
    STATUS=$(docker inspect "$CAPTURE_NAME" --format '{{.State.Health.Status}}' 2>/dev/null || echo "missing")
    case "$STATUS" in
        healthy)
            echo "[tele] capture-mgr healthy (${i}s)"
            break
            ;;
        missing)
            echo "[tele] ERROR: $CAPTURE_NAME missing/crashed. Logs:"
            docker logs "$CAPTURE_NAME" 2>&1 | tail -40
            exit 1
            ;;
        *)
            sleep 1
            ;;
    esac
    if [ "$i" = "30" ]; then
        echo "[tele] WARN: not 'healthy' after 30s (status=$STATUS) — most likely the emu_audio_3 sink"
        echo "[tele]       isn't loaded in pulse-hub. Fine for telephony; HTTP/console still work. Continuing."
    fi
done

echo "[tele] Starting emulator (shared console token mounted)..."
docker run -d \
    --name "$EMULATOR_NAME" \
    --hostname "$EMULATOR_NAME" \
    --network "devicehub_devicehub" \
    --device /dev/kvm \
    --device "/dev/video22:/dev/video0" \
    --group-add video \
    -e EMULATOR_DEVICE="Samsung Galaxy S10" \
    -e WEB_VNC=true \
    -e PULSE_SERVER="unix:/run/pulse/shared.sock" \
    -e PULSE_SINK="emu_audio_3" \
    -e PULSE_SOURCE="emu_mic_3" \
    -e QEMU_AUDIO_DRV=pa \
    -e EMULATOR_ADDITIONAL_ARGS="-allow-host-audio -grpc 8554 -camera-front webcam0" \
    -v "devicehub_pulse-sock:/run/pulse" \
    -v "${TOKEN_FILE}:/home/androidusr/.emulator_console_auth_token" \
    -p "6082:6080" \
    -p "5558:5555" \
    --restart unless-stopped \
    "budtmo/docker-android:emulator_13.0"

echo "[tele] Waiting for emulator boot (up to 2 min)..."
for i in $(seq 1 24); do
    if docker exec "$EMULATOR_NAME" adb shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
        echo "[tele] Emulator boot completed!"
        break
    fi
    echo "[tele] ... still booting ($((i*5))s)"
    sleep 5
done

# ---- OPTIONAL: register the tele device in the shared DeviceHub UI ----------
# Only needed when you want to test the telephony BUTTON in the UI. It's additive
# (adds a device to the shared provider). Skip it for pure backend curl isolation.
# Run from the repo root if you enable it.
#
# if docker ps --format '{{.Names}}' | grep -q '^adbd$'; then
#     docker compose -f docker-compose-prod.yaml --env-file scripts/variables.env exec -T adbd \
#         adb connect "${EMULATOR_NAME}:5555" 2>&1 || echo "[tele] WARN: adb connect failed"
# fi

echo ""
echo "[tele] Ready:"
echo "  Manager API:   http://localhost:7602/api/health        (AUTH_REQUIRED=0 -> curl without JWT)"
echo "  Emulator VNC:  http://localhost:6082/"
echo "  ADB:           adb connect localhost:5558"
echo "  Console token: $TOKEN_FILE  (mounted in mgr at /run/console-token)"
