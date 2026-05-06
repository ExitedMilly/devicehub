'use strict';

const log = require('../log').getLogger('mic/webrtc');
const grpc = require('@grpc/grpc-js');
const { RTCPeerConnection, RTCSessionDescription } = require('@roamhq/wrtc');
const { RTCAudioSink } = require('@roamhq/wrtc').nonstandard;
const { WebSocket } = require('ws');
const { GRPC_PORT, SAMPLE_RATE, CHANNELS } = require('../config');
const { emulatorProto } = require('../grpc-client');
const { int16ArrayToBuffer, downmixToMonoInt16, resampleMonoInt16Nearest } = require('../audio/helpers');

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

        log.info({ serial: this.serial }, 'Browser connected, awaiting WebRTC signaling');

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await this._handleSignaling(msg);
            } catch (err) {
                log.error({ serial: this.serial, err: err.message }, 'Signaling parse error');
            }
        });

        ws.on('close', (code, reason) => {
            log.info({ serial: this.serial, code, reason: reason ? String(reason) : 'none', frames: this.framesReceived, sent: this.pcmBytesSent }, 'Browser disconnected');
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
            }
        });

        ws.on('error', (err) => {
            log.error({ serial: this.serial, err: err.message }, 'WS error');
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
            log.error({ serial: this.serial, err: err.message }, 'Signaling error');
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
            log.error({ serial: this.serial, err: err.message }, 'gRPC injectAudio error');
            this.lastError = 'gRPC: ' + err.message;
        } else {
            log.info({ serial: this.serial }, 'gRPC injectAudio completed');
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

        log.info({ serial: this.serial, callbacks: this.audioCallbacks, inSec, outSec, sentSec, pcmBuffer: this.pcmBuffer.length, maxBuffer: this.maxPcmBufferBytesSeen, underruns: this.grpcUnderruns, trimEvents: this.bufferTrimEvents, trimBytes: this.bufferTrimBytes }, 'DIAG');
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
            log.info({ serial: this.serial, prefillBytes: this.pcmBuffer.length }, 'gRPC sender started');
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
                log.error({ serial: this.serial, err: err.message }, 'gRPC write error');
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

            log.warn({ serial: this.serial, before, after: this.pcmBuffer.length }, 'BUFFER TRIM emergency');
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
                log.warn({ serial: this.serial, bitsPerSample }, 'Unsupported bitsPerSample, dropping audio');
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
                log.warn({ serial: this.serial, deltaMs: delta, expectedMs, sampleRate, frames: inputFrames }, 'SINK GAP');
            }
        }
        this.lastAudioCallbackAt = now;

        this.audioCallbacks++;
        this.audioSamplesIn += inputFrames;

        if (this.audioCallbacks <= 5) {
            log.info({ serial: this.serial, callbackN: this.audioCallbacks, sampleRate, channels: channelCount, bits: bitsPerSample, frames: inputFrames, samplesLen: samples.length }, 'AUDIO IN');
        }

        let monoSamples = downmixToMonoInt16(samples, channelCount);

        if (sampleRate !== SAMPLE_RATE) {
            monoSamples = resampleMonoInt16Nearest(monoSamples, sampleRate, SAMPLE_RATE);
            if (!this._warnedSampleRate) {
                this._warnedSampleRate = true;
                log.info({ serial: this.serial, from: sampleRate, to: SAMPLE_RATE }, 'Resampling');
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

            log.warn({ serial: this.serial, before, after: this.pcmBuffer.length }, 'APPEND emergency trim');
        }
    }

    async _handleOffer(msg) {
        log.info({ serial: this.serial }, 'Received SDP offer');

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

            log.info({ serial: this.serial }, 'Audio track received');
            this.state = 'streaming';

            if (this.audioSink) {
                try { this.audioSink.stop(); } catch (err) { /* ignore */ }
            }
            this.audioSink = new RTCAudioSink(track);
            this.audioSink.ondata = (audioData) => {
                this._appendAudioData(audioData);
            };

            track.onended = () => {
                log.info({ serial: this.serial }, 'Audio track ended');
            };
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection ? this.peerConnection.connectionState : 'unknown';
            log.info({ serial: this.serial, state }, 'Connection state change');
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
            log.info({ serial: this.serial }, 'Sent SDP answer');

            for (const candidate of pendingCandidates) {
                this.client.send(candidate);
            }
            if (pendingCandidates.length > 0) {
                log.info({ serial: this.serial, count: pendingCandidates.length }, 'Flushed buffered ICE candidates');
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
        log.info({ serial: this.serial, received: this.bytesReceived, sent: this.pcmBytesSent }, 'Stopping mic WebRTC');
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

module.exports = { WebRTCMicrophoneInstance };
