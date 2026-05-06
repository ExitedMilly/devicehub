'use strict';

const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const {
    PA_SERVER, CHANNELS, SAMPLE_RATE, FRAME_DURATION_MS,
    OPUS_BITRATE, MAX_RESPAWN_DELAY_MS, CLUSTER_ID,
} = require('../config');
const { PULSE_SINK_PREFIX, SINGLE_MODE, PULSE_SINK_NAME } = require('../config');
const log = require('../log').getLogger('audio/capture');


// ===================== CaptureInstance =====================

class CaptureInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.sinkName = (SINGLE_MODE && PULSE_SINK_NAME)
            ? PULSE_SINK_NAME
            : PULSE_SINK_PREFIX + sinkIndex;
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

        log.info({ serial: this.serial, source: this.monitorSource }, 'Starting FFmpeg capture');

        this.ffmpeg = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'info',
            '-stats',
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
                    log.info({ serial: this.serial, bytes: this.initSegment.length }, 'WebM init segment captured');
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
                    // Lazy require to break circular dep with pulse-monitor.js
                    const { paMonitor } = require('../pulse-monitor');
                    paMonitor.trackDtsError(this.serial);
                } else {
                    log.info({ serial: this.serial, output: msg }, 'FFmpeg');
                }
            }
        });

        this.ffmpeg.on('spawn', () => {
            this.state = 'running';
            this.startedAt = new Date();
            this.respawnCount = 0;
            log.info({ serial: this.serial, pid: this.ffmpeg.pid }, 'FFmpeg started');
        });

        this.ffmpeg.on('error', (err) => {
            this.state = 'error';
            this.lastError = err.message;
            log.error({ serial: this.serial, err: err.message }, 'FFmpeg error');
            this._scheduleRespawn();
        });

        this.ffmpeg.on('exit', (code, signal) => {
            log.info({ serial: this.serial, code, signal }, 'FFmpeg exited');
            this.ffmpeg = null;
            if (this.state !== 'stopped') {
                this.state = 'error';
                this.lastError = 'Exited with code ' + code;
                this._scheduleRespawn();
            }
        });
    }

    stop() {
        log.info({ serial: this.serial }, 'Stopping capture');
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
        log.info({ serial: this.serial, clients: this.clients.size }, 'Client connected');

        if (this.initSegment) {
            ws.send(this.initSegment);
            log.info({ serial: this.serial, bytes: this.initSegment.length }, 'Sent init segment to new client');
        }

        ws.on('close', () => {
            this.clients.delete(ws);
            log.info({ serial: this.serial, clients: this.clients.size }, 'Client disconnected');
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
        log.info({ serial: this.serial, delayMs: delay, attempt: this.respawnCount }, 'Respawning');
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

module.exports = { CaptureInstance };
