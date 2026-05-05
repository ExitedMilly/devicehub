'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { CAMERA_V4L2_DEVICE, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS } = require('../config');

const fs = require('fs');

let cameraWriterProcess = null;

function startCameraWriter() {
    if (cameraWriterProcess) return;

    try {
        require('fs').accessSync(CAMERA_V4L2_DEVICE);
    } catch (err) {
        console.log('[camera] v4l2 device ' + CAMERA_V4L2_DEVICE + ' not available, skipping camera writer');
        return;
    }

    const writerPath = path.join(__dirname, '../camera-writer.js');

    console.log('[camera] Starting persistent camera-writer: ' +
        CAMERA_WIDTH + 'x' + CAMERA_HEIGHT + ' @' + CAMERA_FPS + 'fps → ' + CAMERA_V4L2_DEVICE);

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
                console.log('[camera] ' + line);
            }
        }
    });

    cameraWriterProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error('[camera] writer-err: ' + msg);
    });

    cameraWriterProcess.on('spawn', () => {
        console.log('[camera] Camera writer started (PID ' + cameraWriterProcess.pid + ')');
    });

    cameraWriterProcess.on('exit', (code) => {
        console.log('[camera] Camera writer exited: code=' + code);
        cameraWriterProcess = null;
        // Auto-restart after 2s
        setTimeout(() => {
            if (!cameraWriterProcess) {
                console.log('[camera] Auto-restarting camera writer...');
                startCameraWriter();
            }
        }, 2000);
    });

    cameraWriterProcess.on('error', (err) => {
        console.error('[camera] Camera writer error: ' + err.message);
        cameraWriterProcess = null;
    });
}

function stopCameraWriter() {
    if (!cameraWriterProcess) return;
    console.log('[camera] Stopping camera writer');
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

module.exports = { startCameraWriter, stopCameraWriter, writeCameraFrame, startGlobalBlackFeed, stopGlobalBlackFeed };
