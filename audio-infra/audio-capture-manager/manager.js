const { spawn, execSync } = require('child_process');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');
const grpc = require('@grpc/grpc-js');

// WebRTC for camera input
const { RTCPeerConnection, RTCSessionDescription } = require('@roamhq/wrtc');
const { RTCVideoSink, RTCAudioSink } = require('@roamhq/wrtc').nonstandard;
const walkSimulator = require('./walk-simulator');
const poseScenario = require('./pose-scenario');
const backupLogical = require('./backup-logical');

const config = require('./config');
const {
    MANAGER_PORT, PA_SERVER, OPUS_BITRATE, MIC_PIPE_DIR, GRPC_PORT,
    SAMPLE_RATE, CHANNELS, FRAME_DURATION_MS, MAX_RESPAWN_DELAY_MS,
    MIC_STATE_POLL_MS, CAMERA_V4L2_DEVICE, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS,
    GPS_KEEPALIVE_INTERVAL_MS, PA_POLL_INTERVAL_MS, AUTO_DISCOVER, EMULATOR_MAP_RAW,
    CLUSTER_ID, CAMERA_STATE_POLL_MS,
} = config;
const { instances, micRtcInstances, cameraInstances, gpsSessions, poseStates, lightStates } = require('./stores');
const { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc } = require('./grpc-client');
const { runAdb } = require('./adb-runner');
const { int16ArrayToBuffer, downmixToMonoInt16, resampleMonoInt16Nearest } = require('./audio/helpers');
const { registry } = require('./emulator-registry');
const { paMonitor } = require('./pulse-monitor');
const { CaptureInstance } = require('./audio/capture');
const { micStateMonitor } = require('./mic/state-monitor');
const { cameraStateMonitor } = require('./camera/state-monitor');
const { scaleYUV420 } = require('./camera/scaler');
const {
    startCameraWriter, stopCameraWriter, writeCameraFrame,
    startGlobalBlackFeed, stopGlobalBlackFeed,
} = require('./camera/writer');


class WebRTCMicrophoneInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.hostname = serial.split(':')[0];
        this.grpcAddress = this.hostname + ':' + GRPC_PORT;
        this.state = 'idle';
        this.client = null;
        this.startedAt = null;
        this.lastError = null;
        this.bytesReceived = 0;
        this.pcmBytesSent = 0;
        this.framesReceived = 0;
        this.grpcCall = null;
        this.peerConnection = null;
        this.audioSink = null;
        this.pcmTimer = null;
        this.pcmBuffer = Buffer.alloc(0);
        this.audioSamplesIn = 0;
        this.audioSamplesOut = 0;
        this.audioCallbacks = 0;
        this.grpcUnderruns = 0;
        this.bufferTrimEvents = 0;
        this.bufferTrimBytes = 0;
        this.maxPcmBufferBytesSeen = 0;
        this.lastAudioCallbackAt = 0;
        this.diagTimer = null;
        this.grpcStarted = false;
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
        this.state = 'signaling';
        this.startedAt = new Date();
        this.lastError = null;
        this.bytesReceived = 0;
        this.pcmBytesSent = 0;
        this.framesReceived = 0;
        this.pcmBuffer = Buffer.alloc(0);

        console.log('[mic-rtc:' + this.serial + '] Browser connected, awaiting WebRTC signaling');

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await this._handleSignaling(msg);
            } catch (err) {
                console.error('[mic-rtc:' + this.serial + '] Signaling parse error: ' + err.message);
            }
        });

        ws.on('close', (code, reason) => {
            console.log('[mic-rtc:' + this.serial + '] Browser disconnected (code=' + code +
                ' reason=' + (reason || 'none') +
                ' frames=' + this.framesReceived +
                ' sent=' + this.pcmBytesSent + ')');
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
            }
        });

        ws.on('error', (err) => {
            console.error('[mic-rtc:' + this.serial + '] WS error: ' + err.message);
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
            }
        });
    }

    async _handleSignaling(msg) {
        try {
            if (msg.type === 'offer') {
                await this._handleOffer(msg);
            } else if (msg.type === 'candidate' && msg.candidate && this.peerConnection) {
                await this.peerConnection.addIceCandidate(msg.candidate);
            }
        } catch (err) {
            console.error('[mic-rtc:' + this.serial + '] Signaling error: ' + err.message);
            this.lastError = err.message;
        }
    }

        _startGrpcPipeline() {
    const grpcClient = new emulatorProto.EmulatorController(
        this.grpcAddress,
        grpc.credentials.createInsecure()
    );

    this.grpcCall = grpcClient.injectAudio((err) => {
        if (err) {
            console.error('[mic-rtc:' + this.serial + '] gRPC injectAudio error: ' + err.message);
            this.lastError = 'gRPC: ' + err.message;
        } else {
            console.log('[mic-rtc:' + this.serial + '] gRPC injectAudio completed');
        }
    });

    const SEND_MS = 10;
    const chunkBytes = SAMPLE_RATE * CHANNELS * 2 * SEND_MS / 1000;   // 10ms @ 48k mono s16 = 960B
    const prefillBytes = chunkBytes * 6;                              // 60ms
    const maxBufferBytes = chunkBytes * 100;                          // 1000ms safety cap
    const catchupTargetBytes = chunkBytes * 12;                       // 120ms
    const catchupMaxChunksPerTick = 4;

    this.grpcStarted = false;

    this.diagTimer = setInterval(() => {
        const inSec = (this.audioSamplesIn / SAMPLE_RATE).toFixed(2);
        const outSec = (this.audioSamplesOut / SAMPLE_RATE).toFixed(2);
        const sentSec = (this.pcmBytesSent / 2 / SAMPLE_RATE).toFixed(2);

        console.log(
            '[mic-rtc:' + this.serial + '] DIAG ' +
            'callbacks=' + this.audioCallbacks +
            ' inSec=' + inSec +
            ' outSec=' + outSec +
            ' sentSec=' + sentSec +
            ' pcmBuffer=' + this.pcmBuffer.length + 'B' +
            ' maxBuffer=' + this.maxPcmBufferBytesSeen + 'B' +
            ' underruns=' + this.grpcUnderruns +
            ' trimEvents=' + this.bufferTrimEvents +
            ' trimBytes=' + this.bufferTrimBytes
        );
    }, 5000);

    this.pcmTimer = setInterval(() => {
        if (!this.grpcCall) return;

        if (this.pcmBuffer.length > this.maxPcmBufferBytesSeen) {
            this.maxPcmBufferBytesSeen = this.pcmBuffer.length;
        }

        if (!this.grpcStarted) {
            if (this.pcmBuffer.length < prefillBytes) {
                this.grpcUnderruns++;
                return;
            }
            this.grpcStarted = true;
            console.log(
                '[mic-rtc:' + this.serial + '] gRPC sender started with prefill=' +
                this.pcmBuffer.length + 'B'
            );
        }

        let sentChunksThisTick = 0;

        while (
            this.pcmBuffer.length >= chunkBytes &&
            sentChunksThisTick < catchupMaxChunksPerTick
        ) {
            const chunk = this.pcmBuffer.subarray(0, chunkBytes);
            this.pcmBuffer = this.pcmBuffer.subarray(chunkBytes);
            this.pcmBytesSent += chunk.length;

            try {
                this.grpcCall.write({
                    format: {
                        samplingRate: SAMPLE_RATE,
                        channels: 0,
                        format: 1,
                    },
                    timestamp: Date.now() * 1000,
                    audio: chunk,
                });
            } catch (err) {
                console.error('[mic-rtc:' + this.serial + '] gRPC write error: ' + err.message);
                break;
            }

            sentChunksThisTick++;

            // если backlog уже небольшой — больше не догоняем в этот тик
            if (this.pcmBuffer.length <= catchupTargetBytes) {
                break;
            }
        }

        // emergency trim — только если буфер реально улетел
        if (this.pcmBuffer.length > maxBufferBytes) {
            const before = this.pcmBuffer.length;
            this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - maxBufferBytes);
            this.bufferTrimEvents++;
            this.bufferTrimBytes += (before - this.pcmBuffer.length);

            console.warn(
                '[mic-rtc:' + this.serial + '] BUFFER TRIM emergency: ' +
                before + 'B -> ' + this.pcmBuffer.length + 'B'
            );
        }
    }, SEND_MS);
}

        _appendAudioData(audioData) {
        if (!audioData || !audioData.samples) {
            return;
        }

        const now = Date.now();
        const bitsPerSample = audioData.bitsPerSample || 16;
        const channelCount = audioData.channelCount || 1;
        const sampleRate = audioData.sampleRate || SAMPLE_RATE;

        if (bitsPerSample !== 16) {
            if (!this._warnedBitsPerSample) {
                this._warnedBitsPerSample = true;
                console.warn('[mic-rtc:' + this.serial + '] Unsupported bitsPerSample=' + bitsPerSample + ', dropping audio');
            }
            return;
        }

        let samples = audioData.samples;
        if (!(samples instanceof Int16Array)) {
            samples = new Int16Array(samples);
        }

        const inputFrames = audioData.numberOfFrames || Math.floor(samples.length / channelCount) || 0;
        const expectedMs = inputFrames > 0 ? Math.round(inputFrames * 1000 / sampleRate) : 0;

        if (this.lastAudioCallbackAt) {
            const delta = now - this.lastAudioCallbackAt;
            if (expectedMs > 0 && delta > expectedMs * 2 + 10) {
                console.warn(
                    '[mic-rtc:' + this.serial + '] SINK GAP ' +
                    'delta=' + delta + 'ms expected≈' + expectedMs + 'ms ' +
                    'rate=' + sampleRate + 'Hz frames=' + inputFrames
                );
            }
        }
        this.lastAudioCallbackAt = now;

        this.audioCallbacks++;
        this.audioSamplesIn += inputFrames;

        if (this.audioCallbacks <= 5) {
            console.log(
                '[mic-rtc:' + this.serial + '] AUDIO IN #' + this.audioCallbacks +
                ' rate=' + sampleRate +
                'Hz channels=' + channelCount +
                ' bits=' + bitsPerSample +
                ' frames=' + inputFrames +
                ' samplesLen=' + samples.length
            );
        }

        let monoSamples = downmixToMonoInt16(samples, channelCount);

        if (sampleRate !== SAMPLE_RATE) {
            monoSamples = resampleMonoInt16Nearest(monoSamples, sampleRate, SAMPLE_RATE);
            if (!this._warnedSampleRate) {
                this._warnedSampleRate = true;
                console.log('[mic-rtc:' + this.serial + '] Resampling ' + sampleRate + 'Hz → ' + SAMPLE_RATE + 'Hz');
            }
        }

        this.audioSamplesOut += monoSamples.length;

        const pcmChunk = int16ArrayToBuffer(monoSamples);
        this.bytesReceived += pcmChunk.length;
        this.framesReceived += 1;
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, pcmChunk]);

        // Здесь больше НЕ режем буфер агрессивно.
        // Режем только в gRPC send loop как emergency protection.
        const emergencyCap = SAMPLE_RATE * CHANNELS * 2 * 2.0; // 2 секунды
        if (this.pcmBuffer.length > emergencyCap) {
            const before = this.pcmBuffer.length;
            this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - emergencyCap);
            this.bufferTrimEvents++;
            this.bufferTrimBytes += (before - this.pcmBuffer.length);

            console.warn(
                '[mic-rtc:' + this.serial + '] APPEND emergency trim: ' +
                before + 'B -> ' + this.pcmBuffer.length + 'B'
            );
        }
    }

    async _handleOffer(msg) {
        console.log('[mic-rtc:' + this.serial + '] Received SDP offer');

        this._stopPipeline();
        this._startGrpcPipeline();

        this.peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
            ],
            portRange: { min: 40000, max: 40010 },
        });

        this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        const pendingCandidates = [];
        let answerSent = false;

        this.peerConnection.onicecandidate = (event) => {
            if (!event.candidate) return;
            if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
            const candidateMsg = JSON.stringify({
                type: 'candidate',
                candidate: event.candidate.toJSON(),
            });
            if (answerSent) {
                this.client.send(candidateMsg);
            } else {
                pendingCandidates.push(candidateMsg);
            }
        };

        this.peerConnection.ontrack = (event) => {
            const track = event.track;
            if (track.kind !== 'audio') return;

            console.log('[mic-rtc:' + this.serial + '] Audio track received');
            this.state = 'streaming';

            if (this.audioSink) {
                try { this.audioSink.stop(); } catch (err) { /* ignore */ }
            }
            this.audioSink = new RTCAudioSink(track);
            this.audioSink.ondata = (audioData) => {
                this._appendAudioData(audioData);
            };

            track.onended = () => {
                console.log('[mic-rtc:' + this.serial + '] Audio track ended');
            };
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection ? this.peerConnection.connectionState : 'unknown';
            console.log('[mic-rtc:' + this.serial + '] Connection state: ' + state);
        };

        await this.peerConnection.setRemoteDescription(
            new RTCSessionDescription({ type: 'offer', sdp: msg.sdp })
        );

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        if (this.client && this.client.readyState === WebSocket.OPEN) {
            this.client.send(JSON.stringify({
                type: 'answer',
                sdp: this.peerConnection.localDescription.sdp,
            }));
            answerSent = true;
            console.log('[mic-rtc:' + this.serial + '] Sent SDP answer');

            for (const candidate of pendingCandidates) {
                this.client.send(candidate);
            }
            if (pendingCandidates.length > 0) {
                console.log('[mic-rtc:' + this.serial + '] Flushed ' + pendingCandidates.length + ' buffered ICE candidates');
            }
        }
    }

    _stopPipeline() {
        this.pcmBuffer = Buffer.alloc(0);
        this.grpcStarted = false;

        if (this.audioSink) {
            try { this.audioSink.stop(); } catch (err) { /* ignore */ }
            this.audioSink = null;
        }

        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.ontrack = null;
            this.peerConnection.onconnectionstatechange = null;
            try { this.peerConnection.close(); } catch (err) { /* ignore */ }
            this.peerConnection = null;
        }

        if (this.pcmTimer) {
            clearInterval(this.pcmTimer);
            this.pcmTimer = null;
        }

        if (this.diagTimer) {
            clearInterval(this.diagTimer);
            this.diagTimer = null;
        }

        if (this.grpcCall) {
            try { this.grpcCall.end(); } catch (err) { /* ignore */ }
            this.grpcCall = null;
        }
    }

    stop() {
        if (this.state === 'stopped') return;
        console.log('[mic-rtc:' + this.serial + '] Stopping mic WebRTC (received ' +
            this.bytesReceived + ' PCM bytes, sent ' + this.pcmBytesSent + ' PCM bytes via gRPC)');
        this.state = 'stopped';

        this._stopPipeline();

        if (this.client) {
            try { this.client.close(1000, 'Mic RTC stopped'); } catch (err) { /* ignore */ }
            this.client = null;
        }

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
            framesReceived: this.framesReceived,
            startedAt: this.startedAt,
            lastError: this.lastError,
        };
    }
}

// ===================== Camera Instance =====================

class CameraInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.hostname = serial.split(':')[0];
        this.v4l2Device = CAMERA_V4L2_DEVICE;
        this.state = 'idle';
        this.client = null;
        this.startedAt = null;
        this.lastError = null;
        this.bytesReceived = 0;
        this.framesReceived = 0;
        this.framesWritten = 0;
        this.framesDropped = 0;
        // WebRTC
        this.peerConnection = null;
        this.videoSink = null;
    }

    start(ws) {
        if (this.client) {
            ws.close(4009, 'Camera already in use for ' + this.serial);
            return;
        }

        this.client = ws;
        this.state = 'signaling';
        this.startedAt = new Date();
        this.bytesReceived = 0;
        this.framesReceived = 0;
        this.framesWritten = 0;
        this.framesDropped = 0;
        this.lastError = null;

        console.log('[camera:' + this.serial + '] Browser connected, awaiting WebRTC signaling');

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this._handleSignaling(msg);
            } catch (err) {
                console.error('[camera:' + this.serial + '] Signaling parse error: ' + err.message);
            }
        });

        ws.on('close', (code, reason) => {
            console.log('[camera:' + this.serial + '] Browser disconnected (code=' + code +
                ' reason=' + (reason || 'none') +
                ' frames=' + this.framesReceived +
                ' written=' + this.framesWritten +
                ' dropped=' + this.framesDropped + ')');
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
                // Writer auto-falls back to black frames — no action needed
            }
        });

        ws.on('error', (err) => {
            console.error('[camera:' + this.serial + '] WS error: ' + err.message);
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
            }
        });
    }

    async _handleSignaling(msg) {
    try {
        if (msg.type === 'offer') {
            await this._handleOffer(msg);
        } else if (msg.type === 'candidate' && msg.candidate) {
            if (this.peerConnection) {
                await this.peerConnection.addIceCandidate(msg.candidate);
            }
        }
    } catch (err) {
        console.error('[camera:' + this.serial + '] Signaling error: ' + err.message);
        this.lastError = err.message;
    }
}

    async _handleOffer(msg) {
        console.log('[camera:' + this.serial + '] Received SDP offer');

        // Close previous WebRTC (but NOT the writer — it stays alive)
        this._stopPipeline();

        this.peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
            ],
            portRange: { min: 40000, max: 40010 },
        });

        this.peerConnection.addTransceiver('video', { direction: 'recvonly' });

        const pendingCandidates = [];
        let answerSent = false;

        this.peerConnection.onicecandidate = (event) => {
            if (!event.candidate) return;
            if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
            const candidateMsg = JSON.stringify({
                type: 'candidate',
                candidate: event.candidate.toJSON(),
            });
            if (answerSent) {
                this.client.send(candidateMsg);
            } else {
                pendingCandidates.push(candidateMsg);
            }
        };

        this.peerConnection.ontrack = (event) => {
            const track = event.track;
            if (track.kind !== 'video') return;

            console.log('[camera:' + this.serial + '] Video track received');
            this.state = 'streaming';

            this.videoSink = new RTCVideoSink(track);

            this.videoSink.onframe = ({ frame }) => {
                this.framesReceived++;
                this.bytesReceived += frame.data.length;

                // Scale to target resolution if needed (handles warm-up 320x240, 480x360)
                let frameData;
                if (frame.width === CAMERA_WIDTH && frame.height === CAMERA_HEIGHT) {
                    frameData = Buffer.from(frame.data.buffer);
                } else {
                    frameData = scaleYUV420(frame.data, frame.width, frame.height, CAMERA_WIDTH, CAMERA_HEIGHT);
                    if (this.framesReceived <= 5 || this.framesReceived % 50 === 0) {
                        console.log('[camera:' + this.serial + '] Scaled ' +
                            frame.width + 'x' + frame.height + ' → ' +
                            CAMERA_WIDTH + 'x' + CAMERA_HEIGHT);
                    }
                }

                // Write to persistent camera writer (always 640x480 now)
                const written = writeCameraFrame(frameData);
                if (written) {
                    this.framesWritten++;
                    if (this.framesWritten <= 5) {
                        console.log('[camera:' + this.serial + '] Frame #' + this.framesWritten +
                            ': ' + frame.width + 'x' + frame.height +
                            (frame.width !== CAMERA_WIDTH ? ' (scaled)' : '') +
                            ' dropped=' + this.framesDropped);
                    }
                } else {
                    this.framesDropped++;
                }
            };
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection ? this.peerConnection.connectionState : 'unknown';
            console.log('[camera:' + this.serial + '] Connection state: ' + state);
        };

        await this.peerConnection.setRemoteDescription(
            new RTCSessionDescription({ type: 'offer', sdp: msg.sdp })
        );

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        if (this.client && this.client.readyState === WebSocket.OPEN) {
            this.client.send(JSON.stringify({
                type: 'answer',
                sdp: this.peerConnection.localDescription.sdp,
            }));
            answerSent = true;
            console.log('[camera:' + this.serial + '] Sent SDP answer');

            for (const candidate of pendingCandidates) {
                this.client.send(candidate);
            }
            if (pendingCandidates.length > 0) {
                console.log('[camera:' + this.serial + '] Flushed ' + pendingCandidates.length + ' buffered ICE candidates');
            }
        }
    }

    // Only closes WebRTC. Does NOT touch the camera writer.
    _stopPipeline() {
        if (this.videoSink) {
            try { this.videoSink.stop(); } catch (e) { /* ignore */ }
            this.videoSink = null;
        }
        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.ontrack = null;
            this.peerConnection.onconnectionstatechange = null;
            try { this.peerConnection.close(); } catch (e) { /* ignore */ }
            this.peerConnection = null;
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
            writerPid: cameraWriterProcess ? cameraWriterProcess.pid : null
        };
    }
}
// ===================== HTTP + WebSocket Server =====================
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}


function normalizeGpsProvider(provider) {
    const allowed = new Set(['gps', 'fused', 'network', 'passive']);
    if (!provider || typeof provider !== 'string') return 'gps';
    const normalized = provider.trim().toLowerCase();
    return allowed.has(normalized) ? normalized : 'gps';
}

function validateCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat)) {
        throw new Error('latitude must be a valid number');
    }
    if (!Number.isFinite(lon)) {
        throw new Error('longitude must be a valid number');
    }
    if (lat < -90 || lat > 90) {
        throw new Error('latitude must be between -90 and 90');
    }
    if (lon < -180 || lon > 180) {
        throw new Error('longitude must be between -180 and 180');
    }

    return { lat, lon };
}

async function setMockGpsLocation(serial, latitude, longitude, provider = 'gps') {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const normalizedProvider = normalizeGpsProvider(provider);

    console.log(
        `[gps] Applying mock location to ${serial}: provider=${normalizedProvider}, lat=${lat}, lon=${lon}`
    );

    await runAdb(serial, ['shell', 'cmd', 'location', 'set-location-enabled', 'true']);
    await runAdb(serial, ['shell', 'appops', 'set', '2000', 'android:mock_location', 'allow']);

    const addProviderResult = await runAdb(
        serial,
        ['shell', 'cmd', 'location', 'providers', 'add-test-provider', normalizedProvider],
        { allowFailure: true }
    );

    if (
        !addProviderResult.ok &&
        !/already exists|already added|Duplicate/i.test(
            `${addProviderResult.stderr}\n${addProviderResult.stdout}`
        )
    ) {
        throw new Error(
            `failed to add test provider "${normalizedProvider}": ` +
            (addProviderResult.stderr || addProviderResult.stdout || 'unknown error')
        );
    }

    await runAdb(serial, [
        'shell',
        'cmd',
        'location',
        'providers',
        'set-test-provider-enabled',
        normalizedProvider,
        'true',
    ]);

    // IMPORTANT: cmd location expects LATITUDE,LONGITUDE
    await runAdb(serial, [
        'shell',
        'cmd',
        'location',
        'providers',
        'set-test-provider-location',
        normalizedProvider,
        '--location',
        `${lat},${lon}`,
    ]);

    return {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
    };
}

function stopGpsKeepAlive(serial) {
    const session = gpsSessions.get(serial);
    if (!session) return false;

    if (session.timer) {
        clearInterval(session.timer);
        session.timer = null;
    }

    gpsSessions.delete(serial);
    console.log('[gps] Keepalive stopped for ' + serial);
    return true;
}

function getGpsSessionsStatus() {
    const result = {};
    for (const [serial, session] of gpsSessions) {
        result[serial] = {
            serial: session.serial,
            provider: session.provider,
            latitude: session.latitude,
            longitude: session.longitude,
            intervalMs: session.intervalMs,
            startedAt: session.startedAt,
            lastAppliedAt: session.lastAppliedAt,
            lastError: session.lastError,
            running: session.running,
        };
    }
    return result;
}

async function startGpsKeepAlive(serial, latitude, longitude, provider = 'gps', intervalMs = GPS_KEEPALIVE_INTERVAL_MS) {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const normalizedProvider = normalizeGpsProvider(provider);
    const normalizedIntervalMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 5000
        ? Number(intervalMs)
        : GPS_KEEPALIVE_INTERVAL_MS;

    stopGpsKeepAlive(serial);

    await setMockGpsLocation(serial, lat, lon, normalizedProvider);

    const session = {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
        intervalMs: normalizedIntervalMs,
        timer: null,
        running: false,
        startedAt: new Date().toISOString(),
        lastAppliedAt: new Date().toISOString(),
        lastError: null,
    };

    session.timer = setInterval(async () => {
        if (session.running) return;

        session.running = true;
        try {
            await setMockGpsLocation(serial, session.latitude, session.longitude, session.provider);
            session.lastAppliedAt = new Date().toISOString();
            session.lastError = null;
            console.log(
                '[gps] Keepalive refresh for ' + serial +
                ': ' + session.latitude + ',' + session.longitude +
                ' provider=' + session.provider
            );
        } catch (err) {
            session.lastError = err.message;
            console.error('[gps] Keepalive refresh failed for ' + serial + ': ' + err.message);
        } finally {
            session.running = false;
        }
    }, session.intervalMs);

    gpsSessions.set(serial, session);

    console.log(
        '[gps] Keepalive started for ' + serial +
        ': provider=' + normalizedProvider +
        ', lat=' + lat +
        ', lon=' + lon +
        ', interval=' + normalizedIntervalMs + 'ms'
    );

    return {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
        keepAlive: true,
        intervalMs: normalizedIntervalMs,
        startedAt: session.startedAt,
    };
}

walkSimulator.init({
setMockGpsLocation,
startGpsKeepAlive,
stopGpsKeepAlive,
});

poseScenario.init({
emulatorProto: emulatorProto,
callUnaryGrpc: callUnaryGrpc,
getGrpcAddressFromSerial: getGrpcAddressFromSerial,
setDevicePoseRotation: setDevicePoseRotation,
});


function validatePoseAngles(pitch, yaw, roll) {
    const p = Number(pitch);
    const y = Number(yaw);
    const r = Number(roll);

    if (!Number.isFinite(p)) {
        throw new Error('pitch must be a valid number');
    }
    if (!Number.isFinite(y)) {
        throw new Error('yaw must be a valid number');
    }
    if (!Number.isFinite(r)) {
        throw new Error('roll must be a valid number');
    }

    if (p < -180 || p > 180) {
        throw new Error('pitch must be between -180 and 180');
    }
    if (y < -180 || y > 180) {
        throw new Error('yaw must be between -180 and 180');
    }
    if (r < -180 || r > 180) {
        throw new Error('roll must be between -180 and 180');
    }

    return { pitch: p, yaw: y, roll: r };
}

function getPoseStatesStatus() {
    const result = {};
    for (const [serial, pose] of poseStates) {
        result[serial] = pose;
    }
    return result;
}

function validateLightLux(lux) {
    const value = Number(lux);

    if (!Number.isFinite(value)) {
        throw new Error('lux must be a valid number');
    }
    if (value < 0) {
        throw new Error('lux must be greater than or equal to 0');
    }

    return value;
}

function getLightStatesStatus() {
    const result = {};
    for (const [serial, light] of lightStates) {
        result[serial] = light;
    }
    return result;
}

function extractGrpcNumericValue(response) {
    if (!response || !response.value || !Array.isArray(response.value.data) || response.value.data.length === 0) {
        return null;
    }

    const value = Number(response.value.data[0]);
    return Number.isFinite(value) ? value : null;
}

function parseAdbLightGetOutput(stdout) {
    const match = String(stdout || '').match(/light\s*=\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) return null;

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

async function getAdbLightValue(serial) {
    const result = await runAdb(serial, ['emu', 'sensor', 'get', 'light']);
    return parseAdbLightGetOutput(result.stdout);
}

async function setDeviceLightViaAdb(serial, lux) {
    const normalizedLux = validateLightLux(lux);

    await runAdb(serial, ['emu', 'sensor', 'set', 'light', String(normalizedLux)]);
    const sensorLux = await getAdbLightValue(serial);

    return {
        appliedVia: 'adbConsole',
        physicalLux: null,
        sensorLux: sensorLux,
    };
}

async function setDeviceLightViaGrpcPhysicalModel(serial, lux) {
    if (!emulatorProto) {
        throw new Error('gRPC proto not loaded');
    }

    const normalizedLux = validateLightLux(lux);
    const grpcAddress = getGrpcAddressFromSerial(serial);

    const grpcClient = new emulatorProto.EmulatorController(
        grpcAddress,
        grpc.credentials.createInsecure()
    );

    await callUnaryGrpc(grpcClient, 'setPhysicalModel', {
        target: 'LIGHT',
        value: {
            data: [normalizedLux],
        },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const physicalState = await callUnaryGrpc(grpcClient, 'getPhysicalModel', {
        target: 'LIGHT',
    });

    const sensorState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'LIGHT',
    });

    return {
        appliedVia: 'physicalModel',
        physicalLux: extractGrpcNumericValue(physicalState),
        sensorLux: extractGrpcNumericValue(sensorState),
    };
}

async function setDeviceLight(serial, lux) {
    const normalizedLux = validateLightLux(lux);

    console.log('[light] Applying ambient light to ' + serial + ': lux=' + normalizedLux);

    let appliedVia = null;
    let physicalLux = null;
    let sensorLux = null;
    let fallbackReason = null;

    try {
        const grpcResult = await setDeviceLightViaGrpcPhysicalModel(serial, normalizedLux);
        appliedVia = grpcResult.appliedVia;
        physicalLux = grpcResult.physicalLux;
        sensorLux = grpcResult.sensorLux;

        const hasAcceptableReadback = [physicalLux, sensorLux].some((value) =>
            value !== null && Math.abs(value - normalizedLux) <= 0.01
        );

        if (!hasAcceptableReadback) {
            throw new Error(
                'gRPC light readback mismatch: physical=' +
                String(physicalLux) + ', sensor=' + String(sensorLux)
            );
        }
    } catch (err) {
        fallbackReason = err.message;
        console.warn('[light] gRPC path failed for ' + serial + ', falling back to adb emu: ' + err.message);

        const adbResult = await setDeviceLightViaAdb(serial, normalizedLux);
        appliedVia = adbResult.appliedVia;
        physicalLux = adbResult.physicalLux;
        sensorLux = adbResult.sensorLux;
    }

    const result = {
        serial: serial,
        lux: normalizedLux,
        appliedAt: new Date().toISOString(),
        appliedVia: appliedVia,
        physicalLux: physicalLux,
        sensorLux: sensorLux,
        fallbackReason: fallbackReason,
    };

    lightStates.set(serial, result);
    return result;
}

async function setDevicePoseRotation(serial, pitch, yaw, roll) {
    if (!emulatorProto) {
        throw new Error('gRPC proto not loaded');
    }

    const normalized = validatePoseAngles(pitch, yaw, roll);
    const grpcAddress = getGrpcAddressFromSerial(serial);

    console.log(
        '[pose] Applying rotation to ' + serial +
        ': pitch=' + normalized.pitch +
        ', yaw=' + normalized.yaw +
        ', roll=' + normalized.roll +
        ' via ' + grpcAddress
    );

    const grpcClient = new emulatorProto.EmulatorController(
        grpcAddress,
        grpc.credentials.createInsecure()
    );

    await callUnaryGrpc(grpcClient, 'setPhysicalModel', {
        target: 'ROTATION',
        value: {
            data: [normalized.pitch, normalized.yaw, normalized.roll],
        },
    });

    // Small delay so readback is more reliable
    await new Promise((resolve) => setTimeout(resolve, 500));

    const rotationState = await callUnaryGrpc(grpcClient, 'getPhysicalModel', {
        target: 'ROTATION',
    });

    const accelerationState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'ACCELERATION',
    });

    const orientationState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'ORIENTATION',
    });

    const result = {
        serial,
        pitch: normalized.pitch,
        yaw: normalized.yaw,
        roll: normalized.roll,
        appliedAt: new Date().toISOString(),
        rotation: rotationState && rotationState.value ? rotationState.value.data : null,
        acceleration: accelerationState && accelerationState.value ? accelerationState.value.data : null,
        orientation: orientationState && orientationState.value ? orientationState.value.data : null,
    };

    poseStates.set(serial, result);

    return result;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }
   
    if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            instances: instances.size,
            gpsSessions: gpsSessions.size,
            poseStates: poseStates.size,
            lightStates: lightStates.size,
            autoDiscovery: AUTO_DISCOVER,
            knownQemuInputs: paMonitor.knownSinkInputs.size
        }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/status') {
        const status = {};
        for (const [serial, inst] of instances) status[serial] = inst.toJSON();
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
        res.end(JSON.stringify({ capture: status, micStates: micStates, camera: cameraStatus, cameraStates: cameraStates }, null, 2));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/gps/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: getGpsSessionsStatus(),
        }, null, 2));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pose/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            poses: getPoseStatesStatus(),
        }, null, 2));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/light/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        lights: getLightStatesStatus(),
    }, null, 2));
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

    const gpsStopMatch = url.pathname.match(/^\/api\/gps\/(.+)\/stop$/);
    if (req.method === 'POST' && gpsStopMatch) {
        const serial = decodeURIComponent(gpsStopMatch[1]);
        walkSimulator.stopWalk(serial);
        const stopped = stopGpsKeepAlive(serial);

        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            serial,
            stopped,
        }));
        return;
    }

        const gpsMatch = url.pathname.match(/^\/api\/gps\/(.+)$/);
    if (req.method === 'POST' && gpsMatch) {
        const serial = decodeURIComponent(gpsMatch[1]);
        walkSimulator.stopWalk(serial);

        readJsonBody(req)
            .then(async (body) => {
                const keepAlive = !!body.keepAlive;
                const intervalMs = body.intervalMs || GPS_KEEPALIVE_INTERVAL_MS;

                let result;
                if (keepAlive) {
                    result = await startGpsKeepAlive(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps',
                        intervalMs
                    );
                } else {
                    stopGpsKeepAlive(serial);
                    const onceResult = await setMockGpsLocation(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps'
                    );
                    result = {
                        ...onceResult,
                        keepAlive: false,
                        intervalMs: null,
                    };
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                console.error('[gps] Failed to apply GPS:', err.message);
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return;
    }

    // ----------------- WALK SIMULATION -----------------

if (req.method === 'GET' && url.pathname === '/api/walk/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        sessions: walkSimulator.getAllStatuses(),
    }));
    return;
}

const walkStatusOneMatch = url.pathname.match(/^\/api\/walk\/(.+)\/status$/);
if (req.method === 'GET' && walkStatusOneMatch) {
    const serial = decodeURIComponent(walkStatusOneMatch[1]);
    const status = walkSimulator.getStatus(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, status }));
    return;
}

const walkStartMatch = url.pathname.match(/^\/api\/walk\/(.+)\/start$/);
if (req.method === 'POST' && walkStartMatch) {
    const serial = decodeURIComponent(walkStartMatch[1]);
    readJsonBody(req)
        .then(async (body) => {
            const status = await walkSimulator.startWalk(serial, body || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial, status }));
        })
        .catch((err) => {
            console.error('[walk] start failed:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    return;
}

const walkPauseMatch = url.pathname.match(/^\/api\/walk\/(.+)\/pause$/);
if (req.method === 'POST' && walkPauseMatch) {
    const serial = decodeURIComponent(walkPauseMatch[1]);
    const ok = walkSimulator.pauseWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, paused: ok, status: walkSimulator.getStatus(serial) }));
    return;
}

const walkResumeMatch = url.pathname.match(/^\/api\/walk\/(.+)\/resume$/);
if (req.method === 'POST' && walkResumeMatch) {
    const serial = decodeURIComponent(walkResumeMatch[1]);
    const ok = walkSimulator.resumeWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, resumed: ok, status: walkSimulator.getStatus(serial) }));
    return;
}

const walkStopMatch = url.pathname.match(/^\/api\/walk\/(.+)\/stop$/);
if (req.method === 'POST' && walkStopMatch) {
    const serial = decodeURIComponent(walkStopMatch[1]);
    const stopped = walkSimulator.stopWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, stopped }));
    return;
}

// ----------------- POSE SCENARIO -----------------

if (req.method === 'GET' && url.pathname === '/api/pose/scenario/list') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        scenarios: poseScenario.listScenarios(),
        tickHz: poseScenario.TICK_HZ,
    }));
    return;
}

if (req.method === 'GET' && url.pathname === '/api/pose/scenario/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        sessions: poseScenario.getAllStatuses(),
    }));
    return;
}

    // ----------------- BACKUP (AVD snapshot) -----------------

    const backupRestoreMatch = url.pathname.match(/^\/api\/backup\/(.+)\/restore$/);
    if (req.method === 'POST' && backupRestoreMatch) {
        const serial = decodeURIComponent(backupRestoreMatch[1]);
        backupLogical.restoreBackup(serial)
            .then(function(report) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, report: report }));
            })
            .catch(function(err) {
                console.error('[restore] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }

    const backupStatusMatch = url.pathname.match(/^\/api\/backup\/(.+)\/status$/);
    if (req.method === 'GET' && backupStatusMatch) {
        const serial = decodeURIComponent(backupStatusMatch[1]);
        try {
            const status = backupLogical.getBackupStatus(serial);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    

    const backupCreateMatch = url.pathname.match(/^\/api\/backup\/(.+)$/);
    if (req.method === 'POST' && backupCreateMatch) {
        const serial = decodeURIComponent(backupCreateMatch[1]);
        backupLogical.createBackup(serial)
            .then(function(result) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, result: result }));
            })
            .catch(function(err) {
                console.error('[backup] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }


const poseScStatusOneMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/status$/);
if (req.method === 'GET' && poseScStatusOneMatch) {
    const serial = decodeURIComponent(poseScStatusOneMatch[1]);
    const status = poseScenario.getStatus(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
    return;
}

const poseScStartMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/start$/);
if (req.method === 'POST' && poseScStartMatch) {
    const serial = decodeURIComponent(poseScStartMatch[1]);
    readJsonBody(req)
        .then(async (body) => {
            const status = await poseScenario.startScenario(serial, body || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        })
        .catch((err) => {
            console.error('[pose-scenario] start failed:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    return;
}

const poseScPauseMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/pause$/);
if (req.method === 'POST' && poseScPauseMatch) {
    const serial = decodeURIComponent(poseScPauseMatch[1]);
    const ok = poseScenario.pauseScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, paused: ok, status: poseScenario.getStatus(serial) }));
    return;
}

const poseScResumeMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/resume$/);
if (req.method === 'POST' && poseScResumeMatch) {
    const serial = decodeURIComponent(poseScResumeMatch[1]);
    const ok = poseScenario.resumeScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, resumed: ok, status: poseScenario.getStatus(serial) }));
    return;
}

const poseScStopMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/stop$/);
if (req.method === 'POST' && poseScStopMatch) {
    const serial = decodeURIComponent(poseScStopMatch[1]);
    const stopped = poseScenario.stopScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, stopped: stopped }));
    return;
}

    const poseMatch = url.pathname.match(/^\/api\/pose\/(.+)$/);
    if (req.method === 'POST' && poseMatch) {
        const serial = decodeURIComponent(poseMatch[1]);
        poseScenario.stopScenario(serial);

        readJsonBody(req)
            .then(async (body) => {
                const result = await setDevicePoseRotation(
                    serial,
                    body.pitch,
                    body.yaw,
                    body.roll
                );

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                console.error('[pose] Failed to apply pose:', err.message);
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return;
    }

    const lightMatch = url.pathname.match(/^\/api\/light\/(.+)$/);
    if (req.method === 'POST' && lightMatch) {
    const serial = decodeURIComponent(lightMatch[1]);

    readJsonBody(req)
        .then(async (body) => {
            const result = await setDeviceLight(serial, body.lux);

            res.writeHead(200);
            res.end(JSON.stringify({
                ok: true,
                ...result,
            }));
        })
        .catch((err) => {
            console.error('[light] Failed to apply light:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({
                ok: false,
                error: err.message,
            }));
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

    // Mic input via WebRTC: browser → emulator
    const micRtcMatch = url.pathname.match(/^\/mic-rtc\/(.+)$/);
    if (micRtcMatch) {
        const serial = decodeURIComponent(micRtcMatch[1]);

        let sinkIndex = null;
        const captureInstance = instances.get(serial);
        if (captureInstance) {
            sinkIndex = captureInstance.sinkIndex;
        } else {
            const hostname = serial.split(':')[0];
            const info = registry.resolve(hostname);
            sinkIndex = info.sinkIndex;
        }

        let micRtcInst = micRtcInstances.get(serial);
        if (!micRtcInst || micRtcInst.state === 'stopped') {
            micRtcInst = new WebRTCMicrophoneInstance(serial, sinkIndex);
            micRtcInstances.set(serial, micRtcInst);
        }

        if (micRtcInst.client) {
            ws.close(4009, 'Mic RTC already in use for ' + serial);
            return;
        }

        micRtcInst.start(ws);
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
    console.log('[audio-capture-manager] Mic RTC WS: ws://0.0.0.0:' + MANAGER_PORT + '/mic-rtc/{serial}');
    console.log('[audio-capture-manager] Mic State:  ws://0.0.0.0:' + MANAGER_PORT + '/mic-state/{serial}');
    console.log('[audio-capture-manager] Camera WS:  ws://0.0.0.0:' + MANAGER_PORT + '/camera/{serial}');
    console.log('[audio-capture-manager] Camera State: ws://0.0.0.0:' + MANAGER_PORT + '/camera-state/{serial}');
    console.log('[audio-capture-manager] MIC_PIPE_DIR=' + MIC_PIPE_DIR);
    console.log('[audio-capture-manager] CAMERA_V4L2_DEVICE=' + CAMERA_V4L2_DEVICE);
    console.log('[audio-capture-manager] GPS API: http://0.0.0.0:' + MANAGER_PORT + '/api/gps/{serial}');
    console.log('[audio-capture-manager] GPS keepalive interval=' + GPS_KEEPALIVE_INTERVAL_MS + 'ms');
    console.log('[audio-capture-manager] Pose API: http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}');
    console.log('[audio-capture-manager] Light API: http://0.0.0.0:' + MANAGER_PORT + '/api/light/{serial}');
    console.log('[audio-capture-manager] Walk API: http://0.0.0.0:' + MANAGER_PORT + '/api/walk/{serial}/(start|pause|resume|stop|status)');
    console.log('[audio-capture-manager] Pose Scenario API: http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}/scenario/(start|pause|resume|stop|status)');
    console.log('[audio-capture-manager] Pose Scenario tick=' + poseScenario.TICK_HZ + ' Hz');
    console.log('[audio-capture-manager] Backup API: http://0.0.0.0:' + MANAGER_PORT + '/api/backup/{serial} (POST create, GET /status) — dir: ' + backupLogical.BACKUP_DIR);
    console.log('[audio-capture-manager] Backup: logical (APK + /sdcard/), dir=' + (process.env.BACKUP_DIR || '/backups') + ' — POST /api/backup/{serial}, POST /api/backup/{serial}/restore, GET /api/backup/{serial}/status');
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
    stopCameraWriter();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micRtcInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    for (const serial of Array.from(gpsSessions.keys())) {
        stopGpsKeepAlive(serial);
    }
    walkSimulator.shutdown();
    poseScenario.shutdown();
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    paMonitor.stop();
    micStateMonitor.stop();
    cameraStateMonitor.stop();
    stopCameraWriter();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micRtcInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    for (const serial of Array.from(gpsSessions.keys())) {
        stopGpsKeepAlive(serial);
    }
    walkSimulator.shutdown();
    poseScenario.shutdown();
    server.close(() => process.exit(0));
});
