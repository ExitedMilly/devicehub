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
        res.writeHead(200);
        res.end(JSON.stringify({ capture: status, mic: micStatus }, null, 2));
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

    ws.close(4000, 'Invalid path');
});

// ===================== Startup =====================

server.listen(MANAGER_PORT, '0.0.0.0', () => {
    console.log('[audio-capture-manager] Listening on port ' + MANAGER_PORT);
    console.log('[audio-capture-manager] PA_SERVER=' + PA_SERVER);
    console.log('[audio-capture-manager] AUTO_DISCOVER=' + AUTO_DISCOVER);
    console.log('[audio-capture-manager] PA_POLL_INTERVAL=' + PA_POLL_INTERVAL_MS + 'ms');
    if (EMULATOR_MAP_RAW) {
        console.log('[audio-capture-manager] EMULATOR_MAP=' + EMULATOR_MAP_RAW);
    }
    console.log('[audio-capture-manager] HTTP API: http://0.0.0.0:' + MANAGER_PORT + '/api/');
    console.log('[audio-capture-manager] Audio WS:  ws://0.0.0.0:' + MANAGER_PORT + '/audio/{serial}');
    console.log('[audio-capture-manager] Mic WS:    ws://0.0.0.0:' + MANAGER_PORT + '/mic/{serial}');
    console.log('[audio-capture-manager] MIC_PIPE_DIR=' + MIC_PIPE_DIR);

    // Start PA auto-discovery
    paMonitor.start();
});

process.on('SIGTERM', () => {
    paMonitor.stop();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micInstances) inst.stop();
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    paMonitor.stop();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micInstances) inst.stop();
    server.close(() => process.exit(0));
});
