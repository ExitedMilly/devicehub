'use strict';

const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '7600');
const PA_SERVER = process.env.PA_SERVER || 'unix:/run/pulse/shared.sock';
const OPUS_BITRATE = process.env.OPUS_BITRATE || '64000';
const MIC_PIPE_DIR = process.env.MIC_PIPE_DIR || '/run/pulse/mic_pipes';
const GRPC_PORT = parseInt(process.env.EMULATOR_GRPC_PORT || '8554');
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const MAX_RESPAWN_DELAY_MS = 30000;
const ADB_PORT = parseInt(process.env.EMULATOR_ADB_PORT || '5555');
const PULSE_SINK_PREFIX = process.env.PULSE_SINK_PREFIX || 'emu_audio_';

// Mic state polling interval (how often we check if Android is listening)
const MIC_STATE_POLL_MS = parseInt(process.env.MIC_STATE_POLL_MS || '1500');

// Camera config
const CAMERA_V4L2_DEVICE = process.env.CAMERA_V4L2_DEVICE || '/dev/video0';
const CAMERA_WIDTH = parseInt(process.env.CAMERA_WIDTH || '640');
const CAMERA_HEIGHT = parseInt(process.env.CAMERA_HEIGHT || '480');
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || '25');
const GPS_KEEPALIVE_INTERVAL_MS = parseInt(process.env.GPS_KEEPALIVE_INTERVAL_MS || '20000');
const WEBRTC_PORT_MIN = parseInt(process.env.WEBRTC_PORT_MIN || '40000');
const WEBRTC_PORT_MAX = parseInt(process.env.WEBRTC_PORT_MAX || '40010');

// Auto-discovery config
const PA_POLL_INTERVAL_MS = parseInt(process.env.PA_POLL_INTERVAL || '3000');
const AUTO_DISCOVER = process.env.AUTO_DISCOVER !== 'false'; // enabled by default

// Emulator config: maps container hostname patterns to sink indexes and serials
// Format: EMULATOR_MAP=container_prefix:sink_index:serial,...
// Example: EMULATOR_MAP=emulator-1:1:emulator-1:5555,emulator-2:2:emulator-2:5555
// If not set, auto-assigns based on order of appearance
const EMULATOR_MAP_RAW = process.env.EMULATOR_MAP || '';

// WebM element IDs
const CLUSTER_ID = 0x1f43b675;

const CAMERA_STATE_POLL_MS = parseInt(process.env.CAMERA_STATE_POLL_MS || '1500');

// Single-instance mode (P0.2 prototype)
// When INSTANCE_SERIAL is set, capture-mgr runs in single mode:
// - Only requests for this serial are accepted
// - Status endpoints filter to this serial only
// - PAMonitor / EmulatorRegistry can be configured to skip discovery (PR 2)
const INSTANCE_SERIAL = process.env.INSTANCE_SERIAL || null;
const SINGLE_MODE = INSTANCE_SERIAL !== null;

// Optional: explicit emulator host overrides (used in single mode if set)
const EMULATOR_ADB_HOST = process.env.EMULATOR_ADB_HOST || null;
const EMULATOR_GRPC_HOST = process.env.EMULATOR_GRPC_HOST || null;

// Optional: explicit pulse sink/source names (used in single mode if set, PR 2)
const PULSE_SINK_NAME = process.env.PULSE_SINK_NAME || null;
const PULSE_SOURCE_NAME = process.env.PULSE_SOURCE_NAME || null;

// Auth config (P0.6)
const STF_SECRET = process.env.STF_SECRET || null;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === '1';

// Ownership check config (P0.6 PR 3)
const DEVICEHUB_API_HOST = process.env.DEVICEHUB_API_HOST || 'devicehub-api';
const DEVICEHUB_API_PORT = parseInt(process.env.DEVICEHUB_API_PORT) || 3000;
const OWNERSHIP_CACHE_TTL_MS = parseInt(process.env.OWNERSHIP_CACHE_TTL_MS) || 30000;
const OWNERSHIP_REQUEST_TIMEOUT_MS = parseInt(process.env.OWNERSHIP_REQUEST_TIMEOUT_MS) || 3000;

function isSerialAllowed(serial) {
    if (!SINGLE_MODE) return true;
    return serial === INSTANCE_SERIAL;
}

module.exports = {
    MANAGER_PORT, PA_SERVER, OPUS_BITRATE, MIC_PIPE_DIR, GRPC_PORT,
    WEBRTC_PORT_MIN, WEBRTC_PORT_MAX, ADB_PORT, PULSE_SINK_PREFIX,
    SAMPLE_RATE, CHANNELS, FRAME_DURATION_MS, MAX_RESPAWN_DELAY_MS,
    MIC_STATE_POLL_MS, CAMERA_V4L2_DEVICE, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS,
    GPS_KEEPALIVE_INTERVAL_MS, PA_POLL_INTERVAL_MS, AUTO_DISCOVER, EMULATOR_MAP_RAW,
    CLUSTER_ID, CAMERA_STATE_POLL_MS,
    INSTANCE_SERIAL, SINGLE_MODE,
    EMULATOR_ADB_HOST, EMULATOR_GRPC_HOST,
    PULSE_SINK_NAME, PULSE_SOURCE_NAME,
    STF_SECRET, AUTH_REQUIRED,
    DEVICEHUB_API_HOST, DEVICEHUB_API_PORT,
    OWNERSHIP_CACHE_TTL_MS, OWNERSHIP_REQUEST_TIMEOUT_MS,
    isSerialAllowed,
};
