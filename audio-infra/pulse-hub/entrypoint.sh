#!/bin/bash
set -e

# Clean stale runtime from previous container restarts
rm -rf /tmp/pulse-* 2>/dev/null || true

MAX_SINKS=${MAX_EMU_SINKS:-20}
SOCKET_PATH="/run/pulse/shared.sock"
MIC_PIPE_DIR="/run/pulse/mic_pipes"

# Create mic_pipes dir at runtime (Docker volume overwrites Dockerfile-created dirs)
mkdir -p "$MIC_PIPE_DIR"

echo "[pulse-hub] Starting PulseAudio daemon..."
echo "[pulse-hub] Max sinks: $MAX_SINKS"
echo "[pulse-hub] Socket: $SOCKET_PATH"

# Remove stale shared socket
rm -f "$SOCKET_PATH"

# Start PA with default config, stdin from /dev/null (critical for non-TTY containers)
pulseaudio \
    --daemonize=no \
    --exit-idle-time=-1 \
    --disallow-exit \
    --log-level=notice \
    </dev/null &

PA_PID=$!

# Wait for PA default socket to appear
echo "[pulse-hub] Waiting for PulseAudio (PID=$PA_PID)..."
for i in $(seq 1 30); do
    if pactl info >/dev/null 2>&1; then
        echo "[pulse-hub] PulseAudio is ready."
        break
    fi
    if ! kill -0 $PA_PID 2>/dev/null; then
        echo "[pulse-hub] ERROR: PulseAudio process died"
        exit 1
    fi
    if [ "$i" -eq 30 ]; then
        echo "[pulse-hub] ERROR: PulseAudio not responding after 30s"
        exit 1
    fi
    sleep 1
done

# Add shared unix socket for containers to connect
echo "[pulse-hub] Adding shared socket at $SOCKET_PATH..."
pactl load-module module-native-protocol-unix auth-anonymous=1 socket="$SOCKET_PATH"
sleep 1

pactl --server="unix:$SOCKET_PATH" info >/dev/null 2>&1 \
    && echo "[pulse-hub] Shared socket OK." \
    || { echo "[pulse-hub] ERROR: Shared socket not working"; exit 1; }

# Create null-sinks
echo "[pulse-hub] Creating $MAX_SINKS null-sinks..."
for i in $(seq 1 "$MAX_SINKS"); do
    pactl --server="unix:$SOCKET_PATH" \
        load-module module-null-sink \
        sink_name="emu_audio_${i}" \
        sink_properties=device.description="Emulator_${i}_Audio" \
        2>/dev/null && echo "[pulse-hub]   Created: emu_audio_${i}" \
        || echo "[pulse-hub] WARN: Failed to create sink emu_audio_${i}"
done

echo "[pulse-hub] All sinks created. Listing:"
pactl --server="unix:$SOCKET_PATH" list short sinks

# Create pipe-sources for virtual microphones (browser → emulator mic input)
# Each pipe-source reads PCM from a FIFO file and exposes it as a PulseAudio source.
# FFmpeg will decode browser WebM/Opus → PCM and write into these pipes.
echo "[pulse-hub] Creating $MAX_SINKS pipe-sources for virtual microphones..."
for i in $(seq 1 "$MAX_SINKS"); do
    PIPE_PATH="${MIC_PIPE_DIR}/emu_mic_${i}"
    # Remove stale FIFO from previous runs
    rm -f "$PIPE_PATH"
    pactl --server="unix:$SOCKET_PATH" \
        load-module module-pipe-source \
        source_name="emu_mic_${i}" \
        file="$PIPE_PATH" \
        format=s16le \
        rate=48000 \
        channels=1 \
        source_properties=device.description="Emulator_${i}_Microphone" \
        2>/dev/null && echo "[pulse-hub]   Created: emu_mic_${i} → $PIPE_PATH" \
        || echo "[pulse-hub] WARN: Failed to create source emu_mic_${i}"
done

echo "[pulse-hub] Pipe-sources created. Listing sources:"
pactl --server="unix:$SOCKET_PATH" list short sources

echo "[pulse-hub] Ready. PID=$PA_PID"

# Keep container alive
wait $PA_PID
