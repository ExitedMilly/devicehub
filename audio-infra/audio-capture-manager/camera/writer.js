'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { CAMERA_V4L2_DEVICE, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS } = require('../config');

const fs = require('fs');
const log = require('../log').getLogger('camera/writer');

let cameraWriterProcess = null;

function startCameraWriter() {
    if (cameraWriterProcess) return;

    try {
        require('fs').accessSync(CAMERA_V4L2_DEVICE);
    } catch (err) {
        log.info({ device: CAMERA_V4L2_DEVICE }, 'v4l2 device not available, skipping camera writer');
        return;
    }

    const writerPath = path.join(__dirname, '../camera-writer.js');

    log.info({ width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS, device: CAMERA_V4L2_DEVICE }, 'Starting persistent camera-writer');

    cameraWriterProcess = spawn('node', [
        writerPath,
        String(CAMERA_WIDTH),
        String(CAMERA_HEIGHT),
        String(CAMERA_FPS),
        CAMERA_V4L2_DEVICE
    ], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    cameraWriterProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            for (const line of msg.split('\n')) {
                log.info(line);
            }
        }
    });

    cameraWriterProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) log.error({ msg }, 'Camera writer stderr');
    });

    cameraWriterProcess.on('spawn', () => {
        log.info({ pid: cameraWriterProcess.pid }, 'Camera writer started');
    });

    cameraWriterProcess.on('exit', (code) => {
        log.info({ code }, 'Camera writer exited');
        cameraWriterProcess = null;
        // Auto-restart after 2s
        setTimeout(() => {
            if (!cameraWriterProcess) {
                log.info('Auto-restarting camera writer');
                startCameraWriter();
            }
        }, 2000);
    });

    cameraWriterProcess.on('error', (err) => {
        log.error({ err: err.message }, 'Camera writer error');
        cameraWriterProcess = null;
    });
}

function stopCameraWriter() {
    if (!cameraWriterProcess) return;
    log.info('Stopping camera writer');
    if (cameraWriterProcess.stdin && !cameraWriterProcess.stdin.destroyed) {
        try { cameraWriterProcess.stdin.end(); } catch (e) { /* ignore */ }
    }
    try { cameraWriterProcess.kill('SIGTERM'); } catch (e) { /* ignore */ }
    setTimeout(() => {
        if (cameraWriterProcess) {
            try { cameraWriterProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
            cameraWriterProcess = null;
        }
    }, 2000);
    cameraWriterProcess = null;
}

// Write a raw YUV frame to the persistent writer
// Returns true if written, false if dropped
function writeCameraFrame(frameData) {
    if (!cameraWriterProcess || !cameraWriterProcess.stdin || cameraWriterProcess.stdin.destroyed) {
        return false;
    }
    // Backpressure check: don't overflow the pipe
    if (cameraWriterProcess.stdin.writableLength > cameraWriterProcess.stdin.writableHighWaterMark * 2) {
        return false;
    }
    try {
        cameraWriterProcess.stdin.write(frameData);
        return true;
    } catch (err) {
        return false;
    }
}

// Backward compatibility aliases (used in startup/shutdown code)
function startGlobalBlackFeed() {
    startCameraWriter();
}

function stopGlobalBlackFeed() {
    // NO-OP: writer stays alive, just writes black frames when idle.
    // Only stopCameraWriter() actually kills it (on SIGTERM).
}

function getCameraWriterPid() {
    return cameraWriterProcess ? cameraWriterProcess.pid : null;
}

module.exports = { startCameraWriter, stopCameraWriter, writeCameraFrame, startGlobalBlackFeed, stopGlobalBlackFeed, getCameraWriterPid };
