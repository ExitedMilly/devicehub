#!/bin/bash
# host-setup.sh — preflight checks before running DeviceHub stack.
# Idempotent: safe to run multiple times. Exit 0 if ready, 1 if needs attention.

set -u  # treat unset vars as error, but don't `set -e` — we want to see all problems

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; FAIL=1; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; FAIL=1; }
info()  { echo -e "[INFO]  $*"; }

FAIL=0
DOCKER_NETWORK="${DOCKER_NETWORK:-devicehub_devicehub}"
PULSE_VOLUME="${PULSE_VOLUME:-devicehub_pulse-sock}"
EXPECTED_V4L2_DEVICES=(/dev/video4 /dev/video20 /dev/video21 /dev/video22 /dev/video23 /dev/video24 /dev/video25 /dev/video26)

echo "=== DeviceHub host preflight ==="

# 1. KVM
if [ -e /dev/kvm ]; then
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        ok "/dev/kvm exists and is accessible"
    else
        warn "/dev/kvm exists but current user has no read/write — emulators may need 'sudo' or 'kvm' group"
    fi
else
    fail "/dev/kvm missing — KVM acceleration unavailable, emulators will not work"
fi

# 2. CPU virt extensions
VIRT=$(egrep -c '(vmx|svm)' /proc/cpuinfo)
if [ "$VIRT" -gt 0 ]; then
    ok "CPU virtualization extensions present ($VIRT cores)"
else
    fail "CPU virtualization extensions missing — check BIOS/UEFI"
fi

# 3. v4l2loopback module loaded
if lsmod | grep -q v4l2loopback; then
    ok "v4l2loopback module loaded"
else
    fail "v4l2loopback module not loaded — run: sudo modprobe v4l2loopback"
fi

# 4. v4l2loopback devices present
MISSING=()
for dev in "${EXPECTED_V4L2_DEVICES[@]}"; do
    [ -c "$dev" ] || MISSING+=("$dev")
done
if [ ${#MISSING[@]} -eq 0 ]; then
    ok "All expected v4l2 devices present (${#EXPECTED_V4L2_DEVICES[@]} devices)"
else
    fail "Missing v4l2 devices: ${MISSING[*]}"
    info "Check /etc/modprobe.d/v4l2loopback.conf and reload: sudo modprobe -r v4l2loopback && sudo modprobe v4l2loopback"
fi

# 5. Docker daemon
if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        ok "Docker daemon running"
    else
        fail "Docker daemon not responding — try: sudo systemctl start docker"
    fi
else
    fail "Docker not installed"
fi

# 6. Docker network exists
if docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
    ok "Docker network '$DOCKER_NETWORK' exists"
else
    warn "Docker network '$DOCKER_NETWORK' missing — run: docker network create $DOCKER_NETWORK"
fi

# 7. Pulse volume exists (created by old stack on first start)
if docker volume inspect "$PULSE_VOLUME" >/dev/null 2>&1; then
    ok "Docker volume '$PULSE_VOLUME' exists"
else
    warn "Docker volume '$PULSE_VOLUME' missing — start the old stack first, or run docker volume create $PULSE_VOLUME"
fi

# 8. Pulse-hub container running
if docker ps --format '{{.Names}}' | grep -q '^pulse-hub$'; then
    ok "pulse-hub container is running"
    # 8.1 Verify socket inside the volume
    if docker exec pulse-hub test -S /run/pulse/shared.sock 2>/dev/null; then
        ok "pulse shared socket present"
    else
        fail "pulse shared socket missing — pulse-hub did not initialize correctly"
    fi
    # 8.2 Check expected sinks
    SINK_COUNT=$(docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sinks 2>/dev/null | grep -c "emu_audio_" || true)
    if [ "$SINK_COUNT" -ge 20 ]; then
        ok "pulse-hub has $SINK_COUNT emu_audio_* sinks"
    else
        warn "pulse-hub has only $SINK_COUNT emu_audio_* sinks (expected >= 20)"
    fi
else
    warn "pulse-hub container not running — start the stack before running test slice"
fi

# 9. Summary
echo ""
if [ "$FAIL" -eq 0 ]; then
    ok "Host is ready for DeviceHub stack"
    exit 0
else
    fail "Some checks failed — see [FAIL] and [WARN] above"
    exit 1
fi
