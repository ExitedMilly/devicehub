const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '7600');
const PA_SERVER = process.env.PA_SERVER || 'unix:/run/pulse/shared.sock';
const OPUS_BITRATE = process.env.OPUS_BITRATE || '64000';
const MIC_PIPE_DIR = process.env.MIC_PIPE_DIR || '/run/pulse/mic_pipes';
const GRPC_PORT = parseInt(process.env.EMULATOR_GRPC_PORT || '8554');
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const MAX_RESPAWN_DELAY_MS = 30000;

// Mic state polling interval (how often we check if Android is listening)
const MIC_STATE_POLL_MS = parseInt(process.env.MIC_STATE_POLL_MS || '1500');

// Camera config
const CAMERA_V4L2_DEVICE = process.env.CAMERA_V4L2_DEVICE || '/dev/video0';
const CAMERA_WIDTH = parseInt(process.env.CAMERA_WIDTH || '640');
const CAMERA_HEIGHT = parseInt(process.env.CAMERA_HEIGHT || '480');
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || '25');

// Load emulator gRPC proto
const PROTO_PATH = path.join(__dirname, 'emulator_controller.proto');
let emulatorProto = null;
try {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
    });
    const proto = grpc.loadPackageDefinition(packageDefinition);
    emulatorProto = proto.android.emulation.control;
    console.log('[grpc] Loaded emulator_controller.proto');
} catch (err) {
    console.error('[grpc] Failed to load proto: ' + err.message);
    console.error('[grpc] Microphone input via gRPC will not be available');
}

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

const instances = new Map();
const micInstances = new Map(); // serial → MicrophoneInstance
const cameraInstances = new Map(); // serial → CameraInstance

// ===================== Emulator Registry =====================
// Maps container hostnames to sink indexes and serials

class EmulatorRegistry {
    constructor() {
        // hostname → { sinkIndex, serial }
        this.map = new Map();
        this.nextAutoIndex = 1;
        this._parseEnvMap();
    }

    _parseEnvMap() {
        if (!EMULATOR_MAP_RAW) return;
        // Format: hostname_prefix:sink_index:serial,...
        for (const entry of EMULATOR_MAP_RAW.split(',')) {
            const parts = entry.trim().split(':');
            if (parts.length >= 3) {
                const hostname = parts[0];
                const sinkIndex = parseInt(parts[1]);
                const serial = parts.slice(2).join(':'); // serial may contain ':'
                this.map.set(hostname, { sinkIndex, serial });
                console.log('[registry] Static mapping: ' + hostname + ' → sink ' + sinkIndex + ', serial ' + serial);
                if (sinkIndex >= this.nextAutoIndex) {
                    this.nextAutoIndex = sinkIndex + 1;
                }
            }
        }
    }

    resolve(hostname) {
        // Exact match
        if (this.map.has(hostname)) {
            return this.map.get(hostname);
        }
        // Prefix match (hostname might be full container ID, map has short name)
        for (const [prefix, info] of this.map) {
            if (hostname.startsWith(prefix)) {
                return info;
            }
        }
        // Auto-assign
        const sinkIndex = this.nextAutoIndex++;
        const serial = hostname + ':5555'; // best guess
        const info = { sinkIndex, serial };
        this.map.set(hostname, info);
        console.log('[registry] Auto-assigned: ' + hostname + ' → sink ' + sinkIndex + ', serial ' + serial);
        return info;
    }
}

const registry = new EmulatorRegistry();

// ===================== Mic State Monitor =====================
// Polls PulseAudio source-outputs for QEMU Corked state.
// When Android app requests microphone — QEMU uncorks its source-output (Corked: no → listening).
// When Android app stops — QEMU corks it back (Corked: yes → idle).

class MicStateMonitor {
    constructor() {
        // serial → 'listening' | 'idle' (the last confirmed/sent state)
        this.states = new Map();
        // serial → Set<WebSocket> (subscribers)
        this.subscribers = new Map();
        // serial → adb connected flag
        this.adbConnected = new Map();
        this.timer = null;
    }

    start() {
        console.log('[mic-state] Starting mic state monitor via adb (poll every ' + MIC_STATE_POLL_MS + 'ms)');
        this.timer = setInterval(() => this.pollAll(), MIC_STATE_POLL_MS);
        // First poll after a short delay (let emulators boot)
        setTimeout(() => this.pollAll(), 5000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // Poll all known emulators (from registry)
    pollAll() {
        for (const [hostname, info] of registry.map) {
            this.pollEmulator(hostname, info.serial);
        }
    }

    pollEmulator(hostname, serial) {
        const adbTarget = hostname + ':5555';

        // Ensure adb is connected to this emulator
        if (!this.adbConnected.get(serial)) {
            try {
                execSync('adb connect ' + adbTarget + ' 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
                this.adbConnected.set(serial, true);
                console.log('[mic-state] adb connected to ' + adbTarget);
            } catch (err) {
                // Not ready yet — will retry next poll
                return;
            }
        }

        try {
            // Get last rec start/stop event from Android audio service
            const output = execSync(
                'adb -s ' + adbTarget + ' shell "dumpsys audio" 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processAudioDump(hostname, serial, output);
        } catch (err) {
            // adb failed — mark as disconnected for reconnect on next poll
            this.adbConnected.set(serial, false);
        }
    }

    processAudioDump(hostname, serial, output) {
        // Check RecordActivityMonitor section for active recording sessions.
        // Format varies between adb access methods:
        //
        // Via docker exec emulator:
        //   RecordActivityMonitor dump time: 8:09:20 AM
        //     session:129 -- source client=CAMCORDER ...
        //
        // Via adb from another container:
        //   RecordActivityMonitor dump time: 8:24:57 AM
        //   riid 183; active? true
        //     session:193 -- source client=CAMCORDER ...
        //
        // Idle (both):
        //   RecordActivityMonitor dump time: 8:10:03 AM
        //   Audio event log: ...
        let inRecordMonitor = false;
        let hasActiveSession = false;

        for (const line of output.split('\n')) {
            if (line.includes('RecordActivityMonitor dump time:')) {
                inRecordMonitor = true;
                continue;
            }
            if (inRecordMonitor) {
                const trimmed = line.trim();
                // Active session indicator
                if (trimmed.startsWith('session:') || trimmed.includes('active? true')) {
                    hasActiveSession = true;
                    break;
                }
                // Skip empty lines within the section
                if (trimmed.length === 0) {
                    continue;
                }
                // Lines starting with 'riid' are part of the section — keep scanning
                if (trimmed.startsWith('riid ')) {
                    continue;
                }
                // Any other non-empty line means we've left the section
                break;
            }
        }

        const newState = hasActiveSession ? 'listening' : 'idle';

        const oldState = this.states.get(serial);
        if (oldState !== newState) {
            this.states.set(serial, newState);
            console.log('[mic-state] ' + serial + ': ' + (oldState || 'unknown') + ' → ' + newState);
            this._notifySubscribers(hostname, serial, newState);
        }
    }

    // Get current state for a hostname
    getState(hostname) {
        // Look up by hostname → serial
        const info = registry.map.get(hostname);
        if (info) {
            return this.states.get(info.serial) || 'unknown';
        }
        return 'unknown';
    }

    // Get state by serial (serial format: "hostname:port")
    getStateBySerial(serial) {
        return this.states.get(serial) || 'unknown';
    }

    // Subscribe a WebSocket to state changes for a given serial
    subscribe(serial, ws) {
        const hostname = serial.split(':')[0];
        if (!this.subscribers.has(hostname)) {
            this.subscribers.set(hostname, new Set());
        }
        this.subscribers.get(hostname).add(ws);

        // Send current state immediately
        const currentState = this.getStateBySerial(serial);
        this._sendState(ws, serial, currentState);

        // Trigger immediate poll for this emulator
        const info = registry.map.get(hostname);
        if (info) {
            this.pollEmulator(hostname, info.serial);
        }

        ws.on('close', () => {
            const subs = this.subscribers.get(hostname);
            if (subs) {
                subs.delete(ws);
                if (subs.size === 0) this.subscribers.delete(hostname);
            }
        });
    }

    _notifySubscribers(hostname, serial, state) {
        const subs = this.subscribers.get(hostname);
        if (!subs) return;

        for (const ws of subs) {
            this._sendState(ws, serial, state);
        }
    }

    _sendState(ws, serial, state) {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({
                type: 'mic_state',
                serial: serial,
                state: state // 'listening' | 'idle' | 'unknown'
            }));
        } catch (err) {
            // ignore send errors
        }
    }
}

const micStateMonitor = new MicStateMonitor();

// ===================== Camera State Monitor =====================
// Polls adb "dumpsys media.camera" for Active Camera Clients.
// When Android app opens camera → 'active', closes → 'inactive'.

const CAMERA_STATE_POLL_MS = parseInt(process.env.CAMERA_STATE_POLL_MS || '1500');

class CameraStateMonitor {
    constructor() {
        // serial → 'active' | 'inactive' | 'unknown'
        this.states = new Map();
        // serial → Set<WebSocket>
        this.subscribers = new Map();
        this.timer = null;
    }

    start() {
        console.log('[camera-state] Starting camera state monitor via adb (poll every ' + CAMERA_STATE_POLL_MS + 'ms)');
        this.timer = setInterval(() => this.pollAll(), CAMERA_STATE_POLL_MS);
        setTimeout(() => this.pollAll(), 5000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    pollAll() {
        for (const [hostname, info] of registry.map) {
            this.pollEmulator(hostname, info.serial);
        }
    }

    pollEmulator(hostname, serial) {
        const adbTarget = hostname + ':5555';
        try {
            const output = execSync(
                'adb -s ' + adbTarget + ' shell "dumpsys media.camera" 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processCameraDump(hostname, serial, output);
        } catch (err) {
            // adb failed — skip this poll
        }
    }

    processCameraDump(hostname, serial, output) {
        // Parse "Active Camera Clients:" section
        // When camera is active:
        //   Active Camera Clients:
        //   [
        //   (Camera ID: 0, Cost: 100, PID: 10846, ...)
        //   ]
        // When camera is inactive:
        //   Active Camera Clients:
        //   [
        //   ]
        let inActiveClients = false;
        let inBrackets = false;
        let hasActiveClient = false;

        for (const line of output.split('\n')) {
            const trimmed = line.trim();

            if (trimmed.startsWith('Active Camera Clients:')) {
                inActiveClients = true;
                continue;
            }

            if (inActiveClients) {
                if (trimmed === '[') {
                    inBrackets = true;
                    continue;
                }
                if (trimmed === ']') {
                    break;
                }
                if (inBrackets && trimmed.startsWith('(Camera ID:')) {
                    hasActiveClient = true;
                    break;
                }
                // Any other line after Active Camera Clients that's not [ or ] — end of section
                if (!inBrackets && trimmed.length > 0) {
                    break;
                }
            }
        }

        const newState = hasActiveClient ? 'active' : 'inactive';
        const oldState = this.states.get(serial);
        if (oldState !== newState) {
            this.states.set(serial, newState);
            console.log('[camera-state] ' + serial + ': ' + (oldState || 'unknown') + ' → ' + newState);
            this._notifySubscribers(serial, newState);
        }
    }

    subscribe(serial, ws) {
        const hostname = serial.split(':')[0];
        if (!this.subscribers.has(hostname)) {
            this.subscribers.set(hostname, new Set());
        }
        this.subscribers.get(hostname).add(ws);

        // Send current state immediately
        const currentState = this.states.get(serial) || 'unknown';
        this._sendState(ws, serial, currentState);

        ws.on('close', () => {
            const subs = this.subscribers.get(hostname);
            if (subs) {
                subs.delete(ws);
                if (subs.size === 0) this.subscribers.delete(hostname);
            }
        });
    }

    _notifySubscribers(serial, state) {
        const hostname = serial.split(':')[0];
        const subs = this.subscribers.get(hostname);
        if (!subs) return;
        for (const ws of subs) {
            this._sendState(ws, serial, state);
        }
    }

    _sendState(ws, serial, state) {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({
                type: 'camera_state',
                serial: serial,
                state: state // 'active' | 'inactive' | 'unknown'
            }));
        } catch (err) {
            // ignore
        }
    }
}

const cameraStateMonitor = new CameraStateMonitor();

// ===================== PA Monitor =====================
// Polls PulseAudio for QEMU sink-inputs, auto-routes and auto-starts capture

class PAMonitor {
    constructor() {
        this.knownSinkInputs = new Map(); // sink-input-id → { hostname, sinkIndex, serial }
        this.timer = null;
        this.dtsErrorCounts = new Map(); // serial → count
    }

    start() {
        if (!AUTO_DISCOVER) {
            console.log('[pa-monitor] Auto-discovery disabled');
            return;
        }
        console.log('[pa-monitor] Starting auto-discovery (poll every ' + PA_POLL_INTERVAL_MS + 'ms)');
        this.timer = setInterval(() => this.poll(), PA_POLL_INTERVAL_MS);
        // First poll immediately
        setTimeout(() => this.poll(), 1000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    poll() {
        try {
            const output = execSync(
                'pactl --server="' + PA_SERVER + '" list sink-inputs 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processSinkInputs(output);
        } catch (err) {
            // PA not available — that's ok, will retry
        }
    }

    processSinkInputs(output) {
        const currentInputs = this.parseSinkInputs(output);
        const currentIds = new Set(currentInputs.map(i => i.id));

        // Detect new QEMU sink-inputs
        for (const input of currentInputs) {
            if (input.appBinary !== 'qemu-system-x86_64') continue;

            if (!this.knownSinkInputs.has(input.id)) {
                this.onNewQemu(input);
            } else {
                // Capture may have been stopped — restart if needed
                const info = this.knownSinkInputs.get(input.id);
                const inst = instances.get(info.serial);
                if (!inst || inst.state !== "running") {
                    console.log("[pa-monitor] Capture not running for known input #" + input.id + ", restarting");
                    this.knownSinkInputs.delete(input.id);
                    this.onNewQemu(input);
                }
            }
        }

        // Detect removed sink-inputs
        for (const [id, info] of this.knownSinkInputs) {
            if (!currentIds.has(id)) {
                this.onRemovedQemu(id, info);
            }
        }
    }

    onNewQemu(input) {
        const hostname = input.hostname || 'unknown';
        const info = registry.resolve(hostname);
        const targetSink = 'emu_audio_' + info.sinkIndex;

        console.log('[pa-monitor] New QEMU detected: sink-input #' + input.id +
            ' from ' + hostname + ' → routing to ' + targetSink +
            ', serial=' + info.serial);

        this.knownSinkInputs.set(input.id, {
            hostname: hostname,
            sinkIndex: info.sinkIndex,
            serial: info.serial
        });

        // 1. Route sink-input to correct null-sink
        if (input.sinkName !== targetSink) {
            try {
                execSync(
                    'pactl --server="' + PA_SERVER + '" move-sink-input ' + input.id + ' ' + targetSink,
                    { timeout: 3000 }
                );
                console.log('[pa-monitor] Routed sink-input #' + input.id + ' to ' + targetSink);
            } catch (err) {
                console.error('[pa-monitor] Failed to route sink-input #' + input.id + ': ' + err.message);
            }
        } else {
            console.log('[pa-monitor] Sink-input #' + input.id + ' already on ' + targetSink);
        }

        // 2. Auto-start capture if not already running
        if (!instances.has(info.serial) || instances.get(info.serial).state !== 'running') {
            console.log('[pa-monitor] Auto-starting capture for ' + info.serial);
            const instance = new CaptureInstance(info.serial, info.sinkIndex);
            instances.set(info.serial, instance);
            instance.start();
        }
    }

    onRemovedQemu(id, info) {
        console.log('[pa-monitor] QEMU disconnected: sink-input #' + id +
            ' (serial=' + info.serial + ')');
        this.knownSinkInputs.delete(id);

        // Check if any other sink-inputs exist for this serial
        let hasOther = false;
        for (const [, other] of this.knownSinkInputs) {
            if (other.serial === info.serial) {
                hasOther = true;
                break;
            }
        }

        if (!hasOther) {
            // No more QEMU inputs for this emulator — stop capture
            const instance = instances.get(info.serial);
            if (instance) {
                console.log('[pa-monitor] Auto-stopping capture for ' + info.serial);
                instance.stop();
                instances.delete(info.serial);
            }
        }
    }

    // Track DTS errors for auto-restart
    trackDtsError(serial) {
        const count = (this.dtsErrorCounts.get(serial) || 0) + 1;
        this.dtsErrorCounts.set(serial, count);

        // After 50 DTS errors, restart FFmpeg
        if (count >= 50) {
            this.dtsErrorCounts.set(serial, 0);
            const instance = instances.get(serial);
            if (instance && instance.state === 'running') {
                console.log('[pa-monitor] Too many DTS errors for ' + serial + ', restarting capture');
                instance.stop();
                setTimeout(() => {
                    if (instances.has(serial)) {
                        instances.get(serial).start();
                    } else {
                        const info = this.knownSinkInputs.values().next().value;
                        if (info && info.serial === serial) {
                            const inst = new CaptureInstance(serial, info.sinkIndex);
                            instances.set(serial, inst);
                            inst.start();
                        }
                    }
                }, 1000);
            }
        }
    }

    parseSinkInputs(output) {
        const inputs = [];
        let current = null;

        for (const line of output.split('\n')) {
            const idMatch = line.match(/^Sink Input #(\d+)/);
            if (idMatch) {
                if (current) inputs.push(current);
                current = { id: parseInt(idMatch[1]), sinkName: null, appBinary: null, hostname: null };
                continue;
            }
            if (!current) continue;

            const sinkMatch = line.match(/^\tSink:\s+(\d+)/);
            if (sinkMatch) {
                // We need sink name, not index — will resolve below
                current.sinkIndex = parseInt(sinkMatch[1]);
            }

            const propMatch = line.match(/^\t\t(.+?)\s*=\s*"(.+?)"/);
            if (propMatch) {
                const key = propMatch[1];
                const val = propMatch[2];
                if (key === 'application.process.binary') current.appBinary = val;
                if (key === 'application.process.host') current.hostname = val;
            }
        }
        if (current) inputs.push(current);

        return inputs;
    }
}

const paMonitor = new PAMonitor();

// ===================== CaptureInstance =====================

class CaptureInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.sinkName = 'emu_audio_' + sinkIndex;
        this.monitorSource = this.sinkName + '.monitor';
        this.ffmpeg = null;
        this.state = 'stopped';
        this.clients = new Set();
        this.respawnCount = 0;
        this.respawnTimer = null;
        this.startedAt = null;
        this.lastError = null;
        // WebM init segment buffering
        this.initSegment = null;
        this.initDone = false;
        this.preClusterBuffer = [];
    }

    start() {
        if (this.state === 'running' || this.state === 'starting') return;

        this.state = 'starting';
        this.initSegment = null;
        this.initDone = false;
        this.preClusterBuffer = [];

        console.log('[' + this.serial + '] Starting FFmpeg capture from ' + this.monitorSource);

        this.ffmpeg = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'pulse',
            '-server', PA_SERVER,
            '-i', this.monitorSource,
            '-ac', String(CHANNELS),
            '-ar', String(SAMPLE_RATE),
            '-c:a', 'libopus',
            '-application', 'lowdelay',
            '-frame_duration', String(FRAME_DURATION_MS),
            '-b:a', OPUS_BITRATE,
            '-f', 'webm',
            'pipe:1'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        this.ffmpeg.stdout.on('data', (chunk) => {
            if (!this.initDone) {
                const id = chunk.length >= 4 ? chunk.readUInt32BE(0) : 0;
                if (id === CLUSTER_ID) {
                    this.initSegment = Buffer.concat(this.preClusterBuffer);
                    this.initDone = true;
                    this.preClusterBuffer = null;
                    console.log('[' + this.serial + '] WebM init segment captured: ' + this.initSegment.length + ' bytes');
                    this._broadcast(chunk);
                } else {
                    this.preClusterBuffer.push(Buffer.from(chunk));
                }
            } else {
                this._broadcast(chunk);
            }
        });

        this.ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                // Detect DTS errors for auto-restart
                if (msg.includes('Non-monotonous DTS')) {
                    paMonitor.trackDtsError(this.serial);
                } else {
                    console.log('[' + this.serial + '] FFmpeg: ' + msg);
                }
            }
        });

        this.ffmpeg.on('spawn', () => {
            this.state = 'running';
            this.startedAt = new Date();
            this.respawnCount = 0;
            console.log('[' + this.serial + '] FFmpeg started (PID ' + this.ffmpeg.pid + ')');
        });

        this.ffmpeg.on('error', (err) => {
            this.state = 'error';
            this.lastError = err.message;
            console.error('[' + this.serial + '] FFmpeg error: ' + err.message);
            this._scheduleRespawn();
        });

        this.ffmpeg.on('exit', (code, signal) => {
            console.log('[' + this.serial + '] FFmpeg exited: code=' + code + ' signal=' + signal);
            this.ffmpeg = null;
            if (this.state !== 'stopped') {
                this.state = 'error';
                this.lastError = 'Exited with code ' + code;
                this._scheduleRespawn();
            }
        });
    }

    stop() {
        console.log('[' + this.serial + '] Stopping capture');
        this.state = 'stopped';
        if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
        if (this.ffmpeg) {
            this.ffmpeg.kill('SIGTERM');
            setTimeout(() => { if (this.ffmpeg) this.ffmpeg.kill('SIGKILL'); }, 5000);
            this.ffmpeg = null;
        }
        for (const ws of this.clients) ws.close(1001, 'Capture stopped');
        this.clients.clear();
    }

    addClient(ws) {
        this.clients.add(ws);
        console.log('[' + this.serial + '] Client connected (total: ' + this.clients.size + ')');

        if (this.initSegment) {
            ws.send(this.initSegment);
            console.log('[' + this.serial + '] Sent init segment (' + this.initSegment.length + ' bytes) to new client');
        }

        ws.on('close', () => {
            this.clients.delete(ws);
            console.log('[' + this.serial + '] Client disconnected (total: ' + this.clients.size + ')');
        });
    }

    _broadcast(chunk) {
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk);
            }
        }
    }

    _scheduleRespawn() {
        if (this.state === 'stopped') return;
        this.respawnCount++;
        const delay = Math.min(1000 * Math.pow(2, this.respawnCount - 1), MAX_RESPAWN_DELAY_MS);
        console.log('[' + this.serial + '] Respawning in ' + delay + 'ms (attempt ' + this.respawnCount + ')');
        this.respawnTimer = setTimeout(() => { this.respawnTimer = null; this.start(); }, delay);
    }

    toJSON() {
        return {
            serial: this.serial,
            sinkIndex: this.sinkIndex,
            sinkName: this.sinkName,
            state: this.state,
            clients: this.clients.size,
            respawnCount: this.respawnCount,
            startedAt: this.startedAt,
            lastError: this.lastError,
            ffmpegPid: this.ffmpeg ? this.ffmpeg.pid : null,
            hasInitSegment: !!this.initSegment,
            initSegmentSize: this.initSegment ? this.initSegment.length : 0
        };
    }
}

// ===================== MicrophoneInstance =====================
// Receives WebM/Opus from browser WS, decodes to PCM via FFmpeg,
// sends PCM to Android emulator via gRPC injectAudio.

class MicrophoneInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.hostname = serial.split(':')[0]; // emulator-1:5555 → emulator-1
        this.grpcAddress = this.hostname + ':' + GRPC_PORT;
        this.ffmpeg = null;
        this.grpcCall = null;
        this.state = 'idle'; // idle | running | error | stopped
        this.client = null; // only one browser can feed mic at a time
        this.startedAt = null;
        this.lastError = null;
        this.bytesReceived = 0;
        this.pcmBytesSent = 0;
    }

    start(ws) {
        if (this.client) {
            ws.close(4009, 'Mic already in use for ' + this.serial);
            return;
        }

        if (!emulatorProto) {
            ws.close(4010, 'gRPC proto not loaded');
            return;
        }

        this.client = ws;
        this.state = 'running';
        this.startedAt = new Date();
        this.bytesReceived = 0;
        this.pcmBytesSent = 0;
        this.lastError = null;

        console.log('[mic:' + this.serial + '] Starting mic input via gRPC → ' + this.grpcAddress);

        // Create gRPC client
        const grpcClient = new emulatorProto.EmulatorController(
            this.grpcAddress,
            grpc.credentials.createInsecure()
        );

        // Start injectAudio streaming call
        this.grpcCall = grpcClient.injectAudio((err, response) => {
            if (err) {
                console.error('[mic:' + this.serial + '] gRPC injectAudio error: ' + err.message);
                this.lastError = 'gRPC: ' + err.message;
            } else {
                console.log('[mic:' + this.serial + '] gRPC injectAudio completed');
            }
        });

        // FFmpeg: read WebM/Opus from stdin → decode → output raw PCM s16le to stdout
        // Low-latency flags to minimize internal buffering
        this.ffmpeg = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'warning',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-f', 'webm',
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', String(SAMPLE_RATE),
            '-ac', String(CHANNELS),
            'pipe:1'
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.ffmpeg.on('spawn', () => {
            console.log('[mic:' + this.serial + '] FFmpeg started (PID ' + this.ffmpeg.pid + ')');
        });

        // PCM throttling: collect PCM into 20ms chunks and send at real-time pace
        // 48000 Hz * 1 channel * 2 bytes (s16le) * 0.020s = 1920 bytes per chunk
        const CHUNK_BYTES = SAMPLE_RATE * CHANNELS * 2 * FRAME_DURATION_MS / 1000;
        const MAX_BUFFER_BYTES = CHUNK_BYTES * 5; // max 100ms buffer — drop old data beyond this
        let pcmBuffer = Buffer.alloc(0);
        this.pcmTimer = setInterval(() => {
            if (pcmBuffer.length >= CHUNK_BYTES && this.grpcCall) {
                // Drop stale data: if buffer grew beyond 100ms, skip to latest
                if (pcmBuffer.length > MAX_BUFFER_BYTES) {
                    const dropped = pcmBuffer.length - CHUNK_BYTES;
                    pcmBuffer = pcmBuffer.subarray(pcmBuffer.length - CHUNK_BYTES);
                }
                const chunk = pcmBuffer.subarray(0, CHUNK_BYTES);
                pcmBuffer = pcmBuffer.subarray(CHUNK_BYTES);
                this.pcmBytesSent += chunk.length;
                try {
                    this.grpcCall.write({
                        format: {
                            samplingRate: SAMPLE_RATE,
                            channels: 0, // Mono
                            format: 1    // AUD_FMT_S16
                        },
                        timestamp: Date.now() * 1000,
                        audio: chunk
                    });
                } catch (err) {
                    console.error('[mic:' + this.serial + '] gRPC write error: ' + err.message);
                }
            }
        }, FRAME_DURATION_MS);

        // FFmpeg stdout → PCM buffer (capped to prevent unbounded growth)
        this.ffmpeg.stdout.on('data', (pcmChunk) => {
            pcmBuffer = Buffer.concat([pcmBuffer, pcmChunk]);
            // Hard cap: never let buffer exceed 200ms to prevent memory issues
            if (pcmBuffer.length > MAX_BUFFER_BYTES * 2) {
                pcmBuffer = pcmBuffer.subarray(pcmBuffer.length - CHUNK_BYTES);
            }
        });

        this.ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                console.log('[mic:' + this.serial + '] FFmpeg: ' + msg);
            }
        });

        this.ffmpeg.on('error', (err) => {
            this.state = 'error';
            this.lastError = err.message;
            console.error('[mic:' + this.serial + '] FFmpeg error: ' + err.message);
        });

        this.ffmpeg.on('exit', (code, signal) => {
            console.log('[mic:' + this.serial + '] FFmpeg exited: code=' + code + ' signal=' + signal);
            this.ffmpeg = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
            }
        });

        // Receive WebM/Opus chunks from browser and pipe to FFmpeg stdin
        let lastMessageTime = Date.now();
        ws.on('message', (data) => {
            const now = Date.now();
            const gap = now - lastMessageTime;
            lastMessageTime = now;

            // If gap > 1 second — data is stale, restart FFmpeg+gRPC to flush buffers
            if (gap > 1000 && this.state === 'running') {
                console.log('[mic:' + this.serial + '] Gap detected (' + gap + 'ms), restarting pipeline');
                this._stopPipeline();
                this._startPipeline();
                return;
            }

            if (this.ffmpeg && this.ffmpeg.stdin && !this.ffmpeg.stdin.destroyed) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                this.bytesReceived += buf.length;
                try {
                    this.ffmpeg.stdin.write(buf);
                } catch (err) {
                    console.error('[mic:' + this.serial + '] Write error: ' + err.message);
                }
            }
        });

        ws.on('close', () => {
            console.log('[mic:' + this.serial + '] Browser disconnected');
            this.stop();
        });

        ws.on('error', (err) => {
            console.error('[mic:' + this.serial + '] WS error: ' + err.message);
            this.stop();
        });
    }

    _stopPipeline() {
        if (this.pcmTimer) {
            clearInterval(this.pcmTimer);
            this.pcmTimer = null;
        }
        if (this.ffmpeg) {
            if (this.ffmpeg.stdin && !this.ffmpeg.stdin.destroyed) {
                this.ffmpeg.stdin.end();
            }
            try { this.ffmpeg.kill('SIGKILL'); } catch (e) { /* ignore */ }
            this.ffmpeg = null;
        }
        if (this.grpcCall) {
            try { this.grpcCall.end(); } catch (e) { /* ignore */ }
            this.grpcCall = null;
        }
    }

    stop() {
        if (this.state === 'stopped') return;
        console.log('[mic:' + this.serial + '] Stopping mic input (received ' +
            this.bytesReceived + ' bytes, sent ' + this.pcmBytesSent + ' PCM bytes via gRPC)');
        this.state = 'stopped';

        this._stopPipeline();

        if (this.ffmpeg) {
            if (this.ffmpeg.stdin && !this.ffmpeg.stdin.destroyed) {
                this.ffmpeg.stdin.end();
            }
            const ff = this.ffmpeg;
            setTimeout(() => {
                try { ff.kill('SIGTERM'); } catch (e) { /* ignore */ }
                setTimeout(() => {
                    try { ff.kill('SIGKILL'); } catch (e) { /* ignore */ }
                }, 3000);
            }, 2000);
            this.ffmpeg = null;
        }

        if (this.grpcCall) {
            try { this.grpcCall.end(); } catch (e) { /* ignore */ }
            this.grpcCall = null;
        }

        if (this.client) {
            try { this.client.close(1000, 'Mic stopped'); } catch (e) { /* ignore */ }
            this.client = null;
        }

        // Reset to idle so the next browser can connect
        this.state = 'idle';
    }

    toJSON() {
        return {
            serial: this.serial,
            sinkIndex: this.sinkIndex,
            grpcAddress: this.grpcAddress,
            state: this.state,
            hasClient: !!this.client,
            bytesReceived: this.bytesReceived,
            pcmBytesSent: this.pcmBytesSent,
            startedAt: this.startedAt,
            lastError: this.lastError,
            ffmpegPid: this.ffmpeg ? this.ffmpeg.pid : null
        };
    }
}

// ===================== CameraInstance =====================
// Receives JPEG frames from browser WS.
// Latest-frame-only: only the most recent frame is kept, older frames are dropped.
// FFmpeg (image2pipe/mjpeg → v4l2loopback) with low-latency flags.

const fs = require('fs');

class CameraInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.hostname = serial.split(':')[0];
        this.v4l2Device = CAMERA_V4L2_DEVICE;
        this.ffmpegBrowser = null;
        this.state = 'idle';
        this.client = null;
        this.startedAt = null;
        this.lastError = null;
        this.bytesReceived = 0;
        this.framesReceived = 0;
        this.framesWritten = 0;
        this.framesDropped = 0;
        // Latest-frame-only buffer
        this.latestFrame = null;
        this.writeTimer = null;
    }

    start(ws) {
        if (this.client) {
            ws.close(4009, 'Camera already in use for ' + this.serial);
            return;
        }

        this.client = ws;
        this.state = 'streaming';
        this.startedAt = new Date();
        this.bytesReceived = 0;
        this.framesReceived = 0;
        this.framesWritten = 0;
        this.framesDropped = 0;
        this.lastError = null;
        this.latestFrame = null;

        console.log('[camera:' + this.serial + '] Browser connected, latest-frame MJPEG → ' + this.v4l2Device);

        // Stop global black feed and immediately start pipeline (no delay)
        stopGlobalBlackFeed();
        // Give black feed 200ms to release fd, then start
        setTimeout(() => this._startPipeline(), 200);

        // Each WS message = one complete JPEG frame
        // We overwrite latestFrame on every message — only newest frame matters
        ws.on('message', (data) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.bytesReceived += buf.length;
            this.framesReceived++;

            // Overwrite — latest frame only
            if (this.latestFrame !== null) {
                this.framesDropped++;
            }
            this.latestFrame = buf;
        });

        ws.on('close', () => {
            console.log('[camera:' + this.serial + '] Browser disconnected (recv=' + this.framesReceived +
                ' written=' + this.framesWritten + ' dropped=' + this.framesDropped + ')');
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
                setTimeout(() => startGlobalBlackFeed(), 300);
            }
        });

        ws.on('error', (err) => {
            console.error('[camera:' + this.serial + '] WS error: ' + err.message);
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
                setTimeout(() => startGlobalBlackFeed(), 300);
            }
        });
    }

    _startPipeline() {
        // FFmpeg: MJPEG from stdin → decode → YUV420P → v4l2loopback
        // No scale needed — browser sends exact 640x480 matching v4l2loopback
        // Low-latency: nobuffer, minimal probesize, zero analyzeduration
        this.ffmpegBrowser = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'warning',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-i', 'pipe:0',
            '-pix_fmt', 'yuv420p',
            '-f', 'v4l2',
            this.v4l2Device
        ], {
            stdio: ['pipe', 'ignore', 'pipe']
        });

        this.ffmpegBrowser.on('spawn', () => {
            console.log('[camera:' + this.serial + '] FFmpeg started (PID ' + this.ffmpegBrowser.pid + ')');
            // Start the write loop — pulls latest frame and writes to FFmpeg stdin
            this._startWriteLoop();
        });

        this.ffmpegBrowser.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.log('[camera:' + this.serial + '] FFmpeg: ' + msg);
        });

        this.ffmpegBrowser.on('error', (err) => {
            console.error('[camera:' + this.serial + '] FFmpeg error: ' + err.message);
            this.lastError = err.message;
        });

        this.ffmpegBrowser.on('exit', (code, signal) => {
            console.log('[camera:' + this.serial + '] FFmpeg exited: code=' + code + ' signal=' + signal);
            this.ffmpegBrowser = null;
            this._stopWriteLoop();
        });
    }

    // Write loop: at fixed interval, take the latest frame and write to FFmpeg.
    // If no new frame since last write — skip (don't re-send stale frame).
    _startWriteLoop() {
        const intervalMs = 1000 / CAMERA_FPS; // match target FPS
        this.writeTimer = setInterval(() => {
            if (!this.ffmpegBrowser || !this.ffmpegBrowser.stdin || this.ffmpegBrowser.stdin.destroyed) return;

            const frame = this.latestFrame;
            if (frame === null) return; // no new frame
            this.latestFrame = null; // consume it

            try {
                const ok = this.ffmpegBrowser.stdin.write(frame);
                this.framesWritten++;
                // If write returns false, stdin buffer is full — next frame will be dropped naturally
                // because latestFrame will be overwritten by the time buffer drains
            } catch (err) {
                // ignore write errors
            }
        }, intervalMs);
    }

    _stopWriteLoop() {
        if (this.writeTimer) {
            clearInterval(this.writeTimer);
            this.writeTimer = null;
        }
        this.latestFrame = null;
    }

    _stopPipeline() {
        this._stopWriteLoop();
        if (this.ffmpegBrowser) {
            if (this.ffmpegBrowser.stdin && !this.ffmpegBrowser.stdin.destroyed) {
                try { this.ffmpegBrowser.stdin.end(); } catch (e) { /* ignore */ }
            }
            try { this.ffmpegBrowser.kill('SIGTERM'); } catch (e) { /* ignore */ }
            setTimeout(() => {
                if (this.ffmpegBrowser) {
                    try { this.ffmpegBrowser.kill('SIGKILL'); } catch (e) { /* ignore */ }
                    this.ffmpegBrowser = null;
                }
            }, 2000);
            this.ffmpegBrowser = null;
        }
    }

    stop() {
        if (this.state === 'stopped') return;
        console.log('[camera:' + this.serial + '] Stopping camera instance');
        this.state = 'stopped';
        this._stopPipeline();
        if (this.client) {
            try { this.client.close(1000, 'Camera stopped'); } catch (e) { /* ignore */ }
            this.client = null;
        }
    }

    toJSON() {
        return {
            serial: this.serial,
            sinkIndex: this.sinkIndex,
            v4l2Device: this.v4l2Device,
            state: this.state,
            hasClient: !!this.client,
            bytesReceived: this.bytesReceived,
            framesReceived: this.framesReceived,
            framesWritten: this.framesWritten,
            framesDropped: this.framesDropped,
            startedAt: this.startedAt,
            lastError: this.lastError,
            ffmpegPid: this.ffmpegBrowser ? this.ffmpegBrowser.pid : null
        };
    }
}

// ===================== Global Black Feed =====================
// Maintains a black video feed on v4l2loopback so the emulator always sees a camera.
// CameraInstance stops this when browser streams, restarts when browser disconnects.

let globalBlackFeedProcess = null;

function startGlobalBlackFeed() {
    if (globalBlackFeedProcess) return;

    // Check if v4l2 device exists
    try {
        require('fs').accessSync(CAMERA_V4L2_DEVICE);
    } catch (err) {
        console.log('[camera] v4l2 device ' + CAMERA_V4L2_DEVICE + ' not available, skipping black feed');
        return;
    }

    console.log('[camera] Starting global black feed → ' + CAMERA_V4L2_DEVICE);
    globalBlackFeedProcess = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'warning',
        '-re',
        '-f', 'lavfi',
        '-i', 'color=c=black:size=' + CAMERA_WIDTH + 'x' + CAMERA_HEIGHT + ':rate=' + CAMERA_FPS,
        '-pix_fmt', 'yuv420p',
        '-f', 'v4l2',
        '-video_size', CAMERA_WIDTH + 'x' + CAMERA_HEIGHT,
        CAMERA_V4L2_DEVICE
    ], {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    globalBlackFeedProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('[camera] Global black feed FFmpeg: ' + msg);
    });

    globalBlackFeedProcess.on('spawn', () => {
        console.log('[camera] Global black feed started (PID ' + globalBlackFeedProcess.pid + ')');
    });

    globalBlackFeedProcess.on('exit', (code) => {
        console.log('[camera] Global black feed exited: code=' + code);
        globalBlackFeedProcess = null;
        // Auto-restart after 2s unless a camera instance is streaming
        setTimeout(() => {
            let anyStreaming = false;
            for (const [, inst] of cameraInstances) {
                if (inst.state === 'streaming') { anyStreaming = true; break; }
            }
            if (!anyStreaming && !globalBlackFeedProcess) {
                startGlobalBlackFeed();
            }
        }, 2000);
    });

    globalBlackFeedProcess.on('error', (err) => {
        console.error('[camera] Global black feed error: ' + err.message);
        globalBlackFeedProcess = null;
    });
}

function stopGlobalBlackFeed() {
    if (!globalBlackFeedProcess) return;
    console.log('[camera] Stopping global black feed');
    try { globalBlackFeedProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
    setTimeout(() => {
        if (globalBlackFeedProcess) {
            try { globalBlackFeedProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
            globalBlackFeedProcess = null;
        }
    }, 2000);
    globalBlackFeedProcess = null;
}

// ===================== HTTP + WebSocket Server =====================

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            instances: instances.size,
            micInstances: micInstances.size,
            autoDiscovery: AUTO_DISCOVER,
            knownQemuInputs: paMonitor.knownSinkInputs.size
        }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/status') {
        const status = {};
        for (const [serial, inst] of instances) status[serial] = inst.toJSON();
        const micStatus = {};
        for (const [serial, inst] of micInstances) micStatus[serial] = inst.toJSON();
        // Include mic state per emulator (states are already keyed by serial)
        const micStates = {};
        for (const [serial, state] of micStateMonitor.states) {
            micStates[serial] = state;
        }
        const cameraStatus = {};
        for (const [serial, inst] of cameraInstances) cameraStatus[serial] = inst.toJSON();
        const cameraStates = {};
        for (const [serial, state] of cameraStateMonitor.states) {
            cameraStates[serial] = state;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ capture: status, mic: micStatus, micStates: micStates, camera: cameraStatus, cameraStates: cameraStates }, null, 2));
        return;
    }

    // Manual start (still available, but auto-discovery handles it normally)
    if (req.method === 'POST' && url.pathname === '/api/capture/start') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial, sinkIndex } = JSON.parse(body);
                if (!serial || !sinkIndex) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial and sinkIndex required' })); return; }
                if (instances.has(serial)) {
                    const existing = instances.get(serial);
                    if (existing.state === 'running') {
                        res.writeHead(200);
                        res.end(JSON.stringify({ status: 'already_running', ...existing.toJSON() }));
                        return;
                    }
                    existing.stop();
                }
                const instance = new CaptureInstance(serial, sinkIndex);
                instances.set(serial, instance);
                instance.start();
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'started', ...instance.toJSON() }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/stop') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial } = JSON.parse(body);
                if (!serial) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial required' })); return; }
                const instance = instances.get(serial);
                if (!instance) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
                instance.stop();
                instances.delete(serial);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'stopped', serial }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);

    // Audio output: emulator → browser
    const audioMatch = url.pathname.match(/^\/audio\/(.+)$/);
    if (audioMatch) {
        const serial = decodeURIComponent(audioMatch[1]);
        const instance = instances.get(serial);
        if (!instance) { ws.close(4004, 'No capture for ' + serial); return; }
        if (instance.state !== 'running') { ws.close(4003, 'Not ready: ' + instance.state); return; }
        instance.addClient(ws);
        return;
    }

    // Mic input: browser → emulator
    const micMatch = url.pathname.match(/^\/mic\/(.+)$/);
    if (micMatch) {
        const serial = decodeURIComponent(micMatch[1]);

        // Resolve sinkIndex: check capture instances first, then use registry
        // registry.resolve() will auto-assign if hostname is new
        let sinkIndex = null;
        const captureInstance = instances.get(serial);
        if (captureInstance) {
            sinkIndex = captureInstance.sinkIndex;
        } else {
            // Serial format is "hostname:port" (e.g. "emulator-1:5555")
            const hostname = serial.split(':')[0];
            const info = registry.resolve(hostname);
            sinkIndex = info.sinkIndex;
        }

        // Get or create MicrophoneInstance
        let micInst = micInstances.get(serial);
        if (!micInst || micInst.state === 'stopped') {
            micInst = new MicrophoneInstance(serial, sinkIndex);
            micInstances.set(serial, micInst);
        }

        if (micInst.client) {
            ws.close(4009, 'Mic already in use for ' + serial);
            return;
        }

        micInst.start(ws);
        return;
    }

    // Mic state subscription: browser subscribes to emulator mic state changes
    const micStateMatch = url.pathname.match(/^\/mic-state\/(.+)$/);
    if (micStateMatch) {
        const serial = decodeURIComponent(micStateMatch[1]);
        console.log('[mic-state] Subscriber connected for ' + serial);
        micStateMonitor.subscribe(serial, ws);

        ws.on('close', () => {
            console.log('[mic-state] Subscriber disconnected for ' + serial);
        });
        return;
    }

    // Camera input: browser → emulator (video via v4l2loopback)
    const cameraMatch = url.pathname.match(/^\/camera\/(.+)$/);
    if (cameraMatch) {
        const serial = decodeURIComponent(cameraMatch[1]);

        // Resolve sinkIndex
        let sinkIndex = null;
        const captureInstance = instances.get(serial);
        if (captureInstance) {
            sinkIndex = captureInstance.sinkIndex;
        } else {
            const hostname = serial.split(':')[0];
            const info = registry.resolve(hostname);
            sinkIndex = info.sinkIndex;
        }

        // Get or create CameraInstance
        let camInst = cameraInstances.get(serial);
        if (!camInst || camInst.state === 'stopped') {
            camInst = new CameraInstance(serial, sinkIndex);
            cameraInstances.set(serial, camInst);
        }

        if (camInst.client) {
            ws.close(4009, 'Camera already in use for ' + serial);
            return;
        }

        camInst.start(ws);
        return;
    }

    // Camera state subscription: browser subscribes to camera active/inactive changes
    const cameraStateMatch = url.pathname.match(/^\/camera-state\/(.+)$/);
    if (cameraStateMatch) {
        const serial = decodeURIComponent(cameraStateMatch[1]);
        console.log('[camera-state] Subscriber connected for ' + serial);
        cameraStateMonitor.subscribe(serial, ws);

        ws.on('close', () => {
            console.log('[camera-state] Subscriber disconnected for ' + serial);
        });
        return;
    }

    ws.close(4000, 'Invalid path');
});

// ===================== Startup =====================

server.listen(MANAGER_PORT, '0.0.0.0', () => {
    console.log('[audio-capture-manager] Listening on port ' + MANAGER_PORT);
    console.log('[audio-capture-manager] PA_SERVER=' + PA_SERVER);
    console.log('[audio-capture-manager] AUTO_DISCOVER=' + AUTO_DISCOVER);
    console.log('[audio-capture-manager] PA_POLL_INTERVAL=' + PA_POLL_INTERVAL_MS + 'ms');
    console.log('[audio-capture-manager] MIC_STATE_POLL=' + MIC_STATE_POLL_MS + 'ms');
    if (EMULATOR_MAP_RAW) {
        console.log('[audio-capture-manager] EMULATOR_MAP=' + EMULATOR_MAP_RAW);
    }
    console.log('[audio-capture-manager] HTTP API: http://0.0.0.0:' + MANAGER_PORT + '/api/');
    console.log('[audio-capture-manager] Audio WS:  ws://0.0.0.0:' + MANAGER_PORT + '/audio/{serial}');
    console.log('[audio-capture-manager] Mic WS:    ws://0.0.0.0:' + MANAGER_PORT + '/mic/{serial}');
    console.log('[audio-capture-manager] Mic State:  ws://0.0.0.0:' + MANAGER_PORT + '/mic-state/{serial}');
    console.log('[audio-capture-manager] Camera WS:  ws://0.0.0.0:' + MANAGER_PORT + '/camera/{serial}');
    console.log('[audio-capture-manager] Camera State: ws://0.0.0.0:' + MANAGER_PORT + '/camera-state/{serial}');
    console.log('[audio-capture-manager] MIC_PIPE_DIR=' + MIC_PIPE_DIR);
    console.log('[audio-capture-manager] CAMERA_V4L2_DEVICE=' + CAMERA_V4L2_DEVICE);

    // Start PA auto-discovery
    paMonitor.start();
    // Start mic state monitoring
    micStateMonitor.start();
    // Start camera state monitoring
    cameraStateMonitor.start();

    // Start black feed on v4l2loopback to keep camera alive for emulators
    startGlobalBlackFeed();
});

process.on('SIGTERM', () => {
    paMonitor.stop();
    micStateMonitor.stop();
    cameraStateMonitor.stop();
    stopGlobalBlackFeed();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    paMonitor.stop();
    micStateMonitor.stop();
    cameraStateMonitor.stop();
    stopGlobalBlackFeed();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    server.close(() => process.exit(0));
});
