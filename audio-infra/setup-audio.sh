#!/bin/bash
set -e

#############################################################################
# DeviceHub Audio Infrastructure — Step-by-step setup
#
# This script:
#   1. Copies audio-infra files into DeviceHub repo
#   2. Builds pulse-hub and audio-capture-manager images
#   3. Launches the audio stack + emulator alongside existing DeviceHub
#   4. Verifies each component works
#   5. Triggers audio capture and tests end-to-end
#
# Prerequisites:
#   - DeviceHub already running via docker-compose-prod.yaml
#   - Docker and docker compose installed
#   - Internet access for pulling budtmo/docker-android
#
# Usage:
#   chmod +x setup-audio.sh
#   ./setup-audio.sh
#############################################################################

DEVICEHUB_DIR="${DEVICEHUB_DIR:-$HOME/caller/devicehub}"
AUDIO_INFRA_SRC="$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
step() { echo -e "\n${YELLOW}========== STEP $1 ==========${NC}"; }

# ---- Pre-flight checks ----
step "0: Pre-flight checks"

[ -d "$DEVICEHUB_DIR" ] || fail "DeviceHub dir not found: $DEVICEHUB_DIR"
[ -f "$DEVICEHUB_DIR/docker-compose-prod.yaml" ] || fail "docker-compose-prod.yaml not found"

docker info >/dev/null 2>&1 || fail "Docker not running"
ok "Docker is running"

# Check DeviceHub is up
if docker ps --format '{{.Names}}' | grep -q devicehub-provider; then
    ok "DeviceHub is running"
else
    warn "DeviceHub doesn't appear to be running. Continue anyway? (y/n)"
    read -r ans
    [ "$ans" = "y" ] || exit 0
fi

# ---- Step 1: Copy audio-infra into DeviceHub ----
step "1: Copy audio infrastructure files"

mkdir -p "$DEVICEHUB_DIR/audio-infra/pulse-hub"
mkdir -p "$DEVICEHUB_DIR/audio-infra/audio-capture-manager"

cp "$AUDIO_INFRA_SRC/pulse-hub/Dockerfile" "$DEVICEHUB_DIR/audio-infra/pulse-hub/"
cp "$AUDIO_INFRA_SRC/pulse-hub/entrypoint.sh" "$DEVICEHUB_DIR/audio-infra/pulse-hub/"
cp "$AUDIO_INFRA_SRC/audio-capture-manager/Dockerfile" "$DEVICEHUB_DIR/audio-infra/audio-capture-manager/"
cp "$AUDIO_INFRA_SRC/audio-capture-manager/package.json" "$DEVICEHUB_DIR/audio-infra/audio-capture-manager/"
cp "$AUDIO_INFRA_SRC/audio-capture-manager/manager.js" "$DEVICEHUB_DIR/audio-infra/audio-capture-manager/"
cp "$AUDIO_INFRA_SRC/audio-capture-manager/healthcheck.sh" "$DEVICEHUB_DIR/audio-infra/audio-capture-manager/"
cp "$AUDIO_INFRA_SRC/docker-compose-audio.yaml" "$DEVICEHUB_DIR/"

ok "Files copied to $DEVICEHUB_DIR/audio-infra/"

# ---- Step 2: Build images ----
step "2: Build audio infrastructure images"

cd "$DEVICEHUB_DIR"

echo "Building pulse-hub..."
docker build -t pulse-hub:local ./audio-infra/pulse-hub/
ok "pulse-hub image built"

echo "Building audio-capture-manager..."
docker build -t audio-capture-mgr:local ./audio-infra/audio-capture-manager/
ok "audio-capture-manager image built"

# ---- Step 3: Launch audio stack + emulator ----
step "3: Launch audio stack + emulator"

echo "Starting pulse-hub, audio-capture-mgr, emulator-1..."
echo "Note: First emulator pull may take 5-10 minutes"
docker compose \
    -f docker-compose-prod.yaml \
    -f docker-compose-audio.yaml \
    --env-file scripts/variables.env \
    up -d pulse-hub audio-capture-mgr emulator-1

# ---- Step 4: Verify pulse-hub ----
step "4: Verify PulseAudio hub"

echo "Waiting for pulse-hub to be healthy..."
for i in $(seq 1 30); do
    if docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock info >/dev/null 2>&1; then
        break
    fi
    [ "$i" -eq 30 ] && fail "pulse-hub didn't become healthy in 30s"
    sleep 1
done
ok "pulse-hub is healthy"

echo "Checking null-sinks..."
SINK_COUNT=$(docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sinks | grep -c "emu_audio_" || true)
echo "  Found $SINK_COUNT emulator sinks"
[ "$SINK_COUNT" -ge 1 ] || fail "No emulator sinks found"
ok "PulseAudio sinks created"

# ---- Step 5: Verify audio-capture-manager ----
step "5: Verify audio-capture-manager"

echo "Waiting for audio-capture-manager..."
for i in $(seq 1 15); do
    if curl -sf http://localhost:7600/api/health >/dev/null 2>&1; then
        break
    fi
    [ "$i" -eq 15 ] && fail "audio-capture-manager didn't start in 15s"
    sleep 1
done
ok "audio-capture-manager is healthy"
curl -s http://localhost:7600/api/health | python3 -m json.tool 2>/dev/null || true

# ---- Step 6: Wait for emulator to boot ----
step "6: Wait for emulator to boot"

echo "Waiting for emulator to be ready (this may take 2-5 minutes on first run)..."
echo "You can check progress at http://localhost:6080 (noVNC)"

for i in $(seq 1 300); do
    if docker exec emulator-1 adb shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
        break
    fi
    if [ "$((i % 30))" -eq 0 ]; then
        echo "  Still waiting... (${i}s)"
    fi
    [ "$i" -eq 300 ] && fail "Emulator didn't boot in 5 minutes"
    sleep 1
done
ok "Emulator booted!"

# ---- Step 7: Verify emulator audio is routed to PA ----
step "7: Verify emulator audio reaches PulseAudio"

echo "Checking if emulator's QEMU connected to pulse-hub..."
SINK_INPUTS=$(docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sink-inputs 2>/dev/null || true)
echo "$SINK_INPUTS"

if echo "$SINK_INPUTS" | grep -q "emu_audio_1"; then
    ok "Emulator audio is routed to emu_audio_1 sink!"
else
    warn "No sink-input on emu_audio_1 yet."
    warn "This may be normal — audio appears when the emulator actually plays sound."
    warn "Try playing a YouTube video in the emulator browser to trigger it."
fi

# ---- Step 8: Start audio capture ----
step "8: Start audio capture for emulator"

# Get emulator serial (could be different depending on docker-android config)
EMU_SERIAL="emulator-1:5555"

echo "Starting capture for $EMU_SERIAL on sink index 1..."
CAPTURE_RESULT=$(curl -sf -X POST http://localhost:7600/api/capture/start \
    -H "Content-Type: application/json" \
    -d "{\"serial\": \"$EMU_SERIAL\", \"sinkIndex\": 1}" 2>&1) || true

echo "$CAPTURE_RESULT" | python3 -m json.tool 2>/dev/null || echo "$CAPTURE_RESULT"

# Check capture status
echo ""
echo "Capture status:"
curl -s http://localhost:7600/api/capture/status | python3 -m json.tool 2>/dev/null || true

# ---- Step 9: Test WebSocket audio stream ----
step "9: Test audio stream"

echo ""
echo "Audio capture is running. To test:"
echo ""
echo "  1. Open emulator in browser: http://localhost:6080"
echo "  2. Play some audio (YouTube, music, etc)"
echo "  3. Connect to audio WebSocket to verify data flows:"
echo ""
echo "     # Install wscat if needed: npm install -g wscat"
echo "     wscat -c ws://localhost:7600/audio/$EMU_SERIAL --no-check"
echo ""
echo "     You should see binary data flowing when audio plays."
echo ""
echo "  4. Check capture manager status:"
echo "     curl http://localhost:7600/api/capture/status | python3 -m json.tool"
echo ""

# ---- Summary ----
step "DONE"

echo ""
echo "Services running:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
    --filter "name=pulse-hub" \
    --filter "name=audio-capture-mgr" \
    --filter "name=emulator-1"

echo ""
echo "Endpoints:"
echo "  DeviceHub UI:         https://localhost:443"
echo "  Emulator noVNC:       http://localhost:6080"
echo "  Audio Manager API:    http://localhost:7600/api/capture/status"
echo "  Audio WebSocket:      ws://localhost:7600/audio/$EMU_SERIAL"
echo ""
echo "Next step: Connect emulator to DeviceHub via ADB and integrate audio into provider."
