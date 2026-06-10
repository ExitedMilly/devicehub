'use strict';

const { RTCPeerConnection, RTCSessionDescription } = require('@roamhq/wrtc');
const { RTCVideoSink } = require('@roamhq/wrtc').nonstandard;
const { WebSocket } = require('ws');
const { CAMERA_V4L2_DEVICE, CAMERA_WIDTH, CAMERA_HEIGHT, WEBRTC_PORT_MIN, WEBRTC_PORT_MAX } = require('../config');
const { scaleYUV420 } = require('./scaler');
const { writeCameraFrame, getCameraWriterPid } = require('./writer');
const log = require('../log').getLogger('camera/instance');

class CameraInstance {
    constructor(serial, sinkIndex) {
        this.serial = serial;
        this.sinkIndex = sinkIndex;
        this.hostname = serial.split(':')[0];
        this.v4l2Device = CAMERA_V4L2_DEVICE;
        this.state = 'idle';
        this.client = null;
        this.fileInjectActive = false;
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

        log.info({ serial: this.serial }, 'Browser connected, awaiting WebRTC signaling');

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this._handleSignaling(msg);
            } catch (err) {
                log.error({ serial: this.serial, err: err.message }, 'Signaling parse error');
            }
        });

        ws.on('close', (code, reason) => {
            log.info({ serial: this.serial, code, reason: reason ? String(reason) : 'none', frames: this.framesReceived, written: this.framesWritten, dropped: this.framesDropped }, 'Browser disconnected');
            this._stopPipeline();
            this.client = null;
            if (this.state !== 'stopped') {
                this.state = 'idle';
                // Writer auto-falls back to black frames — no action needed
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
        } else if (msg.type === 'candidate' && msg.candidate) {
            if (this.peerConnection) {
                await this.peerConnection.addIceCandidate(msg.candidate);
            }
        }
    } catch (err) {
        log.error({ serial: this.serial, err: err.message }, 'Signaling error');
        this.lastError = err.message;
    }
}

    async _handleOffer(msg) {
        log.info({ serial: this.serial }, 'Received SDP offer');

        // Close previous WebRTC (but NOT the writer — it stays alive)
        this._stopPipeline();

        this.peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
            ],
            portRange: { min: WEBRTC_PORT_MIN, max: WEBRTC_PORT_MAX },
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

            log.info({ serial: this.serial }, 'Video track received');
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
                        log.info({ serial: this.serial, from: frame.width + 'x' + frame.height, to: CAMERA_WIDTH + 'x' + CAMERA_HEIGHT }, 'Scaled frame');
                    }
                }

                // Write to persistent camera writer (always 640x480 now)
                const written = writeCameraFrame(frameData);
                if (written) {
                    this.framesWritten++;
                    if (this.framesWritten <= 5) {
                        log.info({ serial: this.serial, frameN: this.framesWritten, size: frame.width + 'x' + frame.height, scaled: frame.width !== CAMERA_WIDTH, dropped: this.framesDropped }, 'Frame written');
                    }
                } else {
                    this.framesDropped++;
                }
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
        log.info({ serial: this.serial }, 'Stopping camera instance');
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
            writerPid: getCameraWriterPid()
        };
    }
}

module.exports = { CameraInstance };
