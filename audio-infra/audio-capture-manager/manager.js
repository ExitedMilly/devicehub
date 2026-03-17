const { spawn } = require('child_process');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');

const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '7600');
const PA_SERVER = process.env.PA_SERVER || 'unix:/run/pulse/shared.sock';
const OPUS_BITRATE = process.env.OPUS_BITRATE || '64000';
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const MAX_RESPAWN_DELAY_MS = 30000;

// WebM element IDs
const CLUSTER_ID = 0x1f43b675;

const instances = new Map();

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
                // Check if this chunk starts with a Cluster element (0x1F43B675)
                const id = chunk.length >= 4 ? chunk.readUInt32BE(0) : 0;
                if (id === CLUSTER_ID) {
                    // Everything buffered before this is the WebM init segment
                    // (EBML header + Segment + SegmentInfo + Tracks)
                    this.initSegment = Buffer.concat(this.preClusterBuffer);
                    this.initDone = true;
                    this.preClusterBuffer = null;
                    console.log('[' + this.serial + '] WebM init segment captured: ' + this.initSegment.length + ' bytes');
                    // Broadcast this first cluster
                    this._broadcast(chunk);
                } else {
                    // Still receiving header data
                    this.preClusterBuffer.push(Buffer.from(chunk));
                }
            } else {
                this._broadcast(chunk);
            }
        });

        this.ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.log('[' + this.serial + '] FFmpeg: ' + msg);
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

        // Send WebM init segment so browser MSE can initialize the decoder
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

// --- HTTP + WebSocket Server ---
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', instances: instances.size }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/status') {
        const status = {};
        for (const [serial, inst] of instances) status[serial] = inst.toJSON();
        res.writeHead(200);
        res.end(JSON.stringify(status, null, 2));
        return;
    }

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
                        res.end(JSON.stringify({ status: 'already_running', wsUrl: 'ws://audio-capture-manager:' + MANAGER_PORT + '/audio/' + serial, ...existing.toJSON() }));
                        return;
                    }
                    existing.stop();
                }
                const instance = new CaptureInstance(serial, sinkIndex);
                instances.set(serial, instance);
                instance.start();
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'started', wsUrl: 'ws://audio-capture-manager:' + MANAGER_PORT + '/audio/' + serial, ...instance.toJSON() }));
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
    const match = url.pathname.match(/^\/audio\/(.+)$/);
    if (!match) { ws.close(4000, 'Invalid path'); return; }

    const serial = decodeURIComponent(match[1]);
    const instance = instances.get(serial);
    if (!instance) { ws.close(4004, 'No capture for ' + serial); return; }
    if (instance.state !== 'running') { ws.close(4003, 'Not ready: ' + instance.state); return; }

    instance.addClient(ws);
});

server.listen(MANAGER_PORT, '0.0.0.0', () => {
    console.log('[audio-capture-manager] Listening on port ' + MANAGER_PORT);
    console.log('[audio-capture-manager] PA_SERVER=' + PA_SERVER);
    console.log('[audio-capture-manager] HTTP API: http://0.0.0.0:' + MANAGER_PORT + '/api/');
    console.log('[audio-capture-manager] Audio WS:  ws://0.0.0.0:' + MANAGER_PORT + '/audio/{serial}');
});

process.on('SIGTERM', () => {
    for (const [, inst] of instances) inst.stop();
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    for (const [, inst] of instances) inst.stop();
    server.close(() => process.exit(0));
});
