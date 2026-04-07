#!/usr/bin/env node
// camera-writer.js — persistent helper process
//
// Starts FFmpeg ONCE and keeps it running forever.
// - No data on stdin → writes black frames at fixed FPS
// - Data on stdin → writes real YUV frames
// - stdin EOF → falls back to black (does NOT exit)
//
// This eliminates the v4l2 format/buffer reset that happens
// when FFmpeg restarts. One FFmpeg, one v4l2 session, forever.
//
// Usage: node camera-writer.js <width> <height> <fps> <v4l2device>

const { spawn } = require('child_process');

const width = parseInt(process.argv[2]) || 640;
const height = parseInt(process.argv[3]) || 480;
const fps = parseInt(process.argv[4]) || 15;
const v4l2Device = process.argv[5] || '/dev/video0';
const frameSize = width * height * 1.5;
const INTERVAL_MS = Math.round(1000 / fps);

// Pre-allocate a black frame (YUV420P: Y=0x10, U=V=0x80)
const blackFrame = Buffer.alloc(frameSize);
blackFrame.fill(0x10, 0, width * height);                    // Y plane
blackFrame.fill(0x80, width * height, frameSize);             // U + V planes

let latestFrame = null;
let lastFrameTime = 0;
const FRAME_STALE_MS = 200; // fall back to black if no frame for 200ms

let framesWritten = 0;
let realFrames = 0;
let blackFrames = 0;
let stdinFramesReceived = 0;
let stdinClosed = false;

console.log('[camera-writer] Starting: ' + width + 'x' + height +
    ' @' + fps + 'fps → ' + v4l2Device +
    ' (frame=' + frameSize + 'B, interval=' + INTERVAL_MS + 'ms)');

// Spawn FFmpeg — runs FOREVER
const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size', width + 'x' + height,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-pix_fmt', 'yuv420p',
    '-f', 'v4l2',
    v4l2Device,
], {
    stdio: ['pipe', 'ignore', 'pipe']
});

ffmpeg.on('spawn', () => {
    console.log('[camera-writer] FFmpeg started (PID ' + ffmpeg.pid + ')');
});

ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[camera-writer] FFmpeg: ' + msg);
});

ffmpeg.on('exit', (code) => {
    console.log('[camera-writer] FFmpeg exited: code=' + code);
    clearInterval(writeTimer);
    process.exit(code || 0);
});

ffmpeg.on('error', (err) => {
    console.error('[camera-writer] FFmpeg error: ' + err.message);
    clearInterval(writeTimer);
    process.exit(1);
});

// Read real frames from stdin
let stdinBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);

    // Extract complete frames, keep only latest
    while (stdinBuffer.length >= frameSize) {
        latestFrame = stdinBuffer.subarray(0, frameSize);
        stdinBuffer = stdinBuffer.subarray(frameSize);
        stdinFramesReceived++;
        lastFrameTime = Date.now();
    }
});

process.stdin.on('end', () => {
    console.log('[camera-writer] stdin EOF — falling back to black frames');
    stdinClosed = true;
    latestFrame = null;
});

process.stdin.on('error', () => {
    stdinClosed = true;
    latestFrame = null;
});

// Fixed-interval writer: always write SOMETHING to FFmpeg
const writeTimer = setInterval(() => {
    if (!ffmpeg.stdin || ffmpeg.stdin.destroyed) return;

    const now = Date.now();
    let frameToWrite;

    if (latestFrame && (now - lastFrameTime) < FRAME_STALE_MS) {
        // Fresh real frame available
        frameToWrite = latestFrame;
        latestFrame = null; // consume — don't resend same frame
        realFrames++;
    } else {
        // No fresh frame — write black
        frameToWrite = blackFrame;
        blackFrames++;
    }

    try {
        ffmpeg.stdin.write(frameToWrite);
        framesWritten++;
    } catch (err) {
        // FFmpeg pipe broken — exit
        console.error('[camera-writer] Write error: ' + err.message);
        clearInterval(writeTimer);
        process.exit(1);
    }

    // Log every 10 seconds
    if (framesWritten % (fps * 10) === 0) {
        console.log('[camera-writer] total=' + framesWritten +
            ' real=' + realFrames +
            ' black=' + blackFrames +
            ' stdinRecv=' + stdinFramesReceived +
            ' stdinClosed=' + stdinClosed);
    }
}, INTERVAL_MS);

// Start with black frames immediately (don't wait for stdin)
console.log('[camera-writer] Writing black frames until real data arrives...');

process.on('SIGTERM', () => {
    clearInterval(writeTimer);
    if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    ffmpeg.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
});
