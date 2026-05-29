'use strict';

const { cameraInstances } = require('../stores');
const { CameraInstance } = require('../camera/instance');
const { resolveSinkIndex } = require('./helpers');
const { writeCameraFrame } = require('../camera/writer');
const { isSerialAllowed, INSTANCE_SERIAL, CAMERA_WIDTH, CAMERA_HEIGHT } = require('../config');
const log = require('../log').getLogger('ws/file-video');

const FRAME_SIZE = (CAMERA_WIDTH * CAMERA_HEIGHT * 3) >> 1;

function handleFileVideo(ws, url) {
    const match = url.pathname.match(/^\/file-video\/(.+)$/);
    if (!match) return false;

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }

    let camInst = cameraInstances.get(serial);
    if (!camInst || camInst.state === 'stopped') {
        camInst = new CameraInstance(serial, resolveSinkIndex(serial));
        cameraInstances.set(serial, camInst);
    }

    if (camInst.client) {
        ws.close(4409, 'Camera busy (WebRTC session active)');
        return true;
    }
    if (camInst.fileInjectActive) {
        ws.close(4410, 'Camera busy (another file injection active)');
        return true;
    }

    camInst.fileInjectActive = true;
    log.info({ serial, frameSize: FRAME_SIZE }, 'File-video session started');

    let buffer = Buffer.alloc(0);
    let framesWritten = 0;
    let cleanedUp = false;

    const cleanup = (reason) => {
        if (cleanedUp) return;
        cleanedUp = true;
        camInst.fileInjectActive = false;
        buffer = Buffer.alloc(0);
        log.info({ serial, framesWritten, reason }, 'File-video session stopped');
    };

    ws.on('message', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= FRAME_SIZE) {
            const frame = buffer.subarray(0, FRAME_SIZE);
            writeCameraFrame(frame);
            buffer = buffer.subarray(FRAME_SIZE);
            framesWritten++;
            if (framesWritten % 250 === 0) {
                log.info({ serial, framesWritten }, 'File-video frames written');
            }
        }
    });

    ws.on('close', (code, reason) => {
        cleanup('close ' + code + (reason ? ' ' + String(reason) : ''));
    });

    ws.on('error', (err) => {
        log.error({ serial, err: err.message }, 'File-video WS error');
        cleanup('error');
    });

    return true;
}

module.exports = handleFileVideo;
