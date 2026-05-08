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
const log = require('./log').getLogger('camera-writer-child');

const width = parseInt(process.argv[2]) || 640;
const height = parseInt(process.argv[3]) || 480;
const fps = parseInt(process.argv[4]) || 15;
const v4l2Device = process.argv[5] || '/dev/video0';
const frameSize = (width * height * 3) >> 1;
const INTERVAL_MS = Math.round(1000 / fps);

const LIVE_HOLD_MS = 300;

// newest unread live frame from stdin
let pendingLiveFrame = null;

// last good live frame that can be repeated during short gaps
let lastGoodLiveFrame = null;

// timestamp of the last REAL live frame received from stdin
let lastLiveAt = 0;

// полезно для логов
let held = 0;

// Pre-allocate a black frame (YUV420P: Y=0x10, U=V=0x80)
const blackFrame = Buffer.alloc(frameSize);
blackFrame.fill(0x10, 0, width * height);                    // Y plane
blackFrame.fill(0x80, width * height, frameSize);             // U + V planes



let framesWritten = 0;
let realFrames = 0;
let blackFrames = 0;
let stdinFramesReceived = 0;
let stdinClosed = false;

log.info({ width, height, fps, v4l2Device, frameBytes: frameSize, intervalMs: INTERVAL_MS }, 'Starting');

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
    log.info({ pid: ffmpeg.pid }, 'FFmpeg started');
});

ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log.info({ output: msg }, 'FFmpeg');
});

ffmpeg.on('exit', (code) => {
    if (code !== 0) {
        log.warn({ code, device: v4l2Device }, 'FFmpeg exited with error — parent will respawn child in ~2s');
    } else {
        log.info({ code }, 'FFmpeg exited normally');
    }
    clearInterval(writeTimer);
    process.exit(code || 0);
});

ffmpeg.on('error', (err) => {
    log.error({ err: err.message }, 'FFmpeg error');
    clearInterval(writeTimer);
    process.exit(1);
});

// Read real frames from stdin
let stdinBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);

    // Extract complete frames, keep only the latest unread one
    while (stdinBuffer.length >= frameSize) {
        pendingLiveFrame = Buffer.from(stdinBuffer.subarray(0, frameSize));
        stdinBuffer = stdinBuffer.subarray(frameSize);
        stdinFramesReceived++;
        lastLiveAt = Date.now();
    }
});

process.stdin.on('end', () => {
    log.info('stdin EOF — falling back to black frames');
    stdinClosed = true;
    pendingLiveFrame = null;
});

process.stdin.on('error', () => {
    stdinClosed = true;
    pendingLiveFrame = null;
});

// Fixed-interval writer: always write SOMETHING to FFmpeg
const writeTimer = setInterval(() => {
    if (!ffmpeg.stdin || ffmpeg.stdin.destroyed) return;

    const now = Date.now();
    let frameToWrite;
    let frameKind = 'black';

    if (pendingLiveFrame) {
        // New live frame arrived — show it immediately
        frameToWrite = pendingLiveFrame;
        pendingLiveFrame = null;

        lastGoodLiveFrame = frameToWrite;
        frameKind = 'fresh';
    } else if (lastGoodLiveFrame && (now - lastLiveAt) <= LIVE_HOLD_MS) {
        // No new frame yet, but live was recent — hold last good frame
        frameToWrite = lastGoodLiveFrame;
        frameKind = 'held';
    } else {
        // Live is stale — fall back to black
        frameToWrite = blackFrame;
        frameKind = 'black';
    }

    try {
        ffmpeg.stdin.write(frameToWrite);
        framesWritten++;
    } catch (err) {
        log.error({ err: err.message }, 'Write error');
        clearInterval(writeTimer);
        process.exit(1);
    }

    if (frameKind === 'fresh') {
        realFrames++;
    } else if (frameKind === 'held') {
        realFrames++;
        held++;
    } else {
        blackFrames++;
    }

    // Log every 10 seconds
    if (framesWritten % (fps * 10) === 0) {
        log.info({ total: framesWritten, real: realFrames, held, black: blackFrames, stdinRecv: stdinFramesReceived, stdinClosed }, 'Frame stats');
    }
}, INTERVAL_MS);

// Start with black frames immediately (don't wait for stdin)
log.info('Writing black frames until real data arrives');

process.on('SIGTERM', () => {
    clearInterval(writeTimer);
    if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    ffmpeg.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
});
