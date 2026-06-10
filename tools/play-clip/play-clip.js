#!/usr/bin/env node
'use strict';

// play-clip — remote client for DeviceHub P1.1 file injection.
//
// Reads a local mp4, decodes it with FFmpeg, and streams:
//   - raw YUV420P 640x480 @25fps -> WS /file-video/{serial} -> virtual camera
//   - raw PCM s16le 48000Hz mono -> WS /file-audio/{serial} -> emulator mic
// The clip plays once in the target emulator, then the server auto-returns the
// camera to black and the mic to silence once we stop sending / close.
//
// This is SELF-CONTAINED client tooling. It runs on a remote machine, NOT inside
// the capture-mgr container, and imports nothing from audio-infra/. Only dep: ws.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// FFmpeg output formats are FIXED and must match the server exactly.
// ---------------------------------------------------------------------------
const VIDEO_W = 640;
const VIDEO_H = 480;
const VIDEO_FPS = 25;
const AUDIO_RATE = 48000;

const BACKPRESSURE_HIGH = 16 * 1024 * 1024; // 16MB: pause source above this
const BACKPRESSURE_LOW = 8 * 1024 * 1024;   // resume below this

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] WARN: ${msg}`); }
function err(msg) { console.error(`[${ts()}] ERROR: ${msg}`); }

function printUsage() {
  console.log(`Usage: node play-clip.js <video.mp4> <serial> [options]

Arguments:
  <video.mp4>        Path to a local video file (must exist).
  <serial>           Emulator serial, e.g. emulator-test1:5555

Options:
  --server <host>    Server host. Default: $DEVICEHUB_SERVER or "localhost".
  --port <n>         Port. Default 443 (https/wss via nginx).
                     Use 7601 for direct-to-container local testing (http/ws).
  --insecure         Allow self-signed TLS (rejectUnauthorized=false). DeviceHub
                     uses a self-signed cert, so this is commonly required.
  -h, --help         Show this help.

Auth token (NOT a CLI arg, to avoid leaking via ps/history):
  1. ~/.devicehub_token  (trimmed file contents)
  2. $DEVICEHUB_TOKEN
  Sent as WS subprotocol "access_token.<jwt>" and HTTP "Authorization: Bearer".
`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    server: process.env.DEVICEHUB_SERVER || 'localhost',
    port: 443,
    insecure: false,
    video: null,
    serial: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') opts.server = argv[++i];
    else if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--insecure') opts.insecure = true;
    else if (a === '-h' || a === '--help') { printUsage(); process.exit(0); }
    else if (a.startsWith('--')) { err(`unknown flag: ${a}`); printUsage(); process.exit(1); }
    else positional.push(a);
  }
  opts.video = positional[0];
  opts.serial = positional[1];
  return opts;
}

// ---------------------------------------------------------------------------
// Token resolution: file first, then env. Never from CLI.
// ---------------------------------------------------------------------------
function resolveToken() {
  const tokenPath = path.join(os.homedir(), '.devicehub_token');
  try {
    if (fs.existsSync(tokenPath)) {
      const t = fs.readFileSync(tokenPath, 'utf8').trim();
      if (t) return t;
    }
  } catch (e) {
    warn(`could not read ${tokenPath}: ${e.message}`);
  }
  if (process.env.DEVICEHUB_TOKEN && process.env.DEVICEHUB_TOKEN.trim()) {
    return process.env.DEVICEHUB_TOKEN.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preflight: GET /api/file-inject/{serial} (direct) or
//            /manager-api/file-inject/{serial} (through nginx on :443).
// Returns { status, body } or { error }.
// ---------------------------------------------------------------------------
function preflight(cfg) {
  // Path mapping: port 443 goes through nginx (which prefixes /manager-api);
  // any other port is assumed to be direct-to-container (/api). PR 5 will
  // formalize the nginx route mapping.
  const basePath = cfg.port === 443 ? '/manager-api/file-inject' : '/api/file-inject';
  const reqPath = `${basePath}/${encodeURIComponent(cfg.serial)}`;
  const lib = cfg.scheme === 'https' ? https : http;

  return new Promise((resolve) => {
    const options = {
      host: cfg.server,
      port: cfg.port,
      path: reqPath,
      method: 'GET',
      headers: cfg.token ? { authorization: 'Bearer ' + cfg.token } : {},
      timeout: 10000,
    };
    if (cfg.scheme === 'https' && cfg.insecure) options.rejectUnauthorized = false;

    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('preflight request timed out')));
    req.on('error', (e) => resolve({ error: e }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  if (!cfg.video || !cfg.serial) {
    err('missing required <video.mp4> and/or <serial>');
    printUsage();
    process.exit(1);
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
    err('invalid --port');
    process.exit(1);
  }
  if (!fs.existsSync(cfg.video)) {
    err(`video file not found: ${cfg.video}`);
    process.exit(1);
  }

  // Scheme: 443 -> TLS (https/wss); anything else -> plaintext (http/ws).
  cfg.scheme = cfg.port === 443 ? 'https' : 'http';
  cfg.wsScheme = cfg.port === 443 ? 'wss' : 'ws';
  cfg.token = resolveToken();

  log(`target: ${cfg.scheme}://${cfg.server}:${cfg.port}  serial=${cfg.serial}`);
  log(`video:  ${cfg.video}`);
  if (cfg.token) log('auth:   token loaded');
  else warn('auth:   no token found (~/.devicehub_token or $DEVICEHUB_TOKEN). On an auth-required server the WS will be rejected with 4001.');

  // --- Preflight (only meaningful with a token; skip otherwise and let the WS gate) ---
  if (cfg.token) {
    const pf = await preflight(cfg);
    if (pf.error) {
      err(`preflight failed: ${pf.error.message}`);
      process.exit(1);
    }
    if (pf.status === 200) {
      let params = {};
      try { params = JSON.parse(pf.body); } catch (e) {
        err(`preflight returned 200 but non-JSON body: ${pf.body}`);
        process.exit(1);
      }
      log(`preflight ok: ${JSON.stringify(params)}`);
    } else if (pf.status === 401) {
      err('preflight 401 — token invalid or expired. Refresh ~/.devicehub_token.');
      process.exit(1);
    } else if (pf.status === 403) {
      err('preflight 403 — serial not allowed / device not owned by this token.');
      process.exit(1);
    } else if (pf.status === 409) {
      err('preflight 409 — camera busy (WebRTC session active). Try again later.');
      process.exit(1);
    } else {
      err(`preflight unexpected status ${pf.status}: ${pf.body}`);
      process.exit(1);
    }
  } else {
    warn('skipping preflight (no token) — relying on WS handshake to gate access.');
  }

  // --- State + cleanup (idempotent) ---
  let videoWs = null;
  let audioWs = null;
  let videoFf = null;
  let audioFf = null;
  let progressTimer = null;
  let cleaned = false;
  let videoDone = false;
  let audioDone = false;
  const stats = { video: 0, audio: 0 };

  function killFf(p) {
    if (p && p.exitCode === null && !p.killed) {
      try { p.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  }
  function closeWs(w) {
    if (w && (w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING)) {
      try { w.close(1000, 'client done'); } catch (e) { /* ignore */ }
    }
  }
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    killFf(videoFf);
    killFf(audioFf);
    closeWs(videoWs);
    closeWs(audioWs);
  }
  function abort(message, code) {
    if (cleaned) return;
    err(message);
    cleanup();
    // Give close frames a moment to flush, then exit non-zero.
    setTimeout(() => process.exit(code || 1), 200);
  }
  function finishSuccess() {
    if (cleaned) return;
    log(`clip finished — sent video=${(stats.video / 1048576).toFixed(2)}MB audio=${(stats.audio / 1048576).toFixed(2)}MB`);
    cleanup();
    log('closed sockets; emulator returns to black/silence. Done.');
    setTimeout(() => process.exit(0), 200);
  }

  process.on('SIGINT', () => { warn('SIGINT received — shutting down'); abort('interrupted by SIGINT', 130); });
  process.on('SIGTERM', () => { warn('SIGTERM received — shutting down'); abort('terminated by SIGTERM', 143); });

  // --- Connect both WebSockets, wait for both to open ---
  const subprotocol = cfg.token ? 'access_token.' + cfg.token : undefined;
  const wsOptions = {};
  if (cfg.wsScheme === 'wss' && cfg.insecure) wsOptions.rejectUnauthorized = false;

  // WS paths are the DIRECT container form. Through nginx they may be prefixed;
  // PR 5 will handle that mapping. Local :7601 testing uses these exactly.
  const videoUrl = `${cfg.wsScheme}://${cfg.server}:${cfg.port}/file-video/${encodeURIComponent(cfg.serial)}`;
  const audioUrl = `${cfg.wsScheme}://${cfg.server}:${cfg.port}/file-audio/${encodeURIComponent(cfg.serial)}`;

  function rejectHint(code) {
    switch (code) {
      case 4001: return ' — missing/invalid token. Put a valid JWT in ~/.devicehub_token or set $DEVICEHUB_TOKEN.';
      case 4002: return ' — serial not allowed on this instance.';
      case 4003: return ' — forbidden: this token does not own the device.';
      case 4009: return ' — already in use (legacy guard).';
      case 4010: return ' — gRPC proto not loaded on the server.';
      case 4409: return ' — busy: the other modality (e.g. a WebRTC session) is active.';
      case 4410: return ' — busy: another file-injection session is already active.';
      default: return '';
    }
  }

  function connectBoth() {
    return new Promise((resolve, reject) => {
      let videoOpen = false;
      let audioOpen = false;
      let settled = false;

      function maybeResolve() {
        if (videoOpen && audioOpen && !settled) { settled = true; resolve(); }
      }
      function failConnect(name, code, reason) {
        if (settled) return;
        settled = true;
        reject(new Error(`${name} WS rejected: code=${code} reason="${reason}"${rejectHint(code)}`));
      }

      function makeSocket(name) {
        const url = name === 'video' ? videoUrl : audioUrl;
        const w = new WebSocket(url, subprotocol, wsOptions);
        w.on('open', () => {
          log(`${name} WS open`);
          if (name === 'video') videoOpen = true; else audioOpen = true;
          maybeResolve();
        });
        w.on('error', (e) => {
          // 'error' typically precedes 'close'; let 'close' carry the code.
          // If there is no close (e.g. DNS/connect failure), surface it here.
          if (!settled && !(name === 'video' ? videoOpen : audioOpen)) {
            failConnect(name, 0, e.message);
          } else if (!cleaned) {
            warn(`${name} WS error: ${e.message}`);
          }
        });
        w.on('close', (code, reasonBuf) => {
          const reason = reasonBuf ? reasonBuf.toString() : '';
          const wasOpen = (name === 'video') ? videoOpen : audioOpen;
          if (!settled) {
            failConnect(name, code, reason);
          } else if (!cleaned) {
            // Closed mid-stream after a successful start -> abort the whole run.
            abort(`${name} WS closed mid-stream: code=${code} reason="${reason}"${rejectHint(code)}`, 2);
          }
          if (name === 'video') videoOpen = false; else audioOpen = false;
          void wasOpen;
        });
        return w;
      }

      videoWs = makeSocket('video');
      audioWs = makeSocket('audio');
    });
  }

  try {
    await connectBoth();
  } catch (e) {
    err(e.message);
    cleanup();
    setTimeout(() => process.exit(1), 200);
    return;
  }
  log('both WS open');

  // --- Pipe an ffmpeg stdout into a WS with minimal backpressure handling ---
  function pipeToWs(stdout, w, name) {
    stdout.on('data', (chunk) => {
      if (cleaned || w.readyState !== WebSocket.OPEN) return;
      w.send(chunk);
      stats[name] += chunk.length;
      if (w.bufferedAmount > BACKPRESSURE_HIGH) {
        stdout.pause();
        // Resume once the socket buffer drains. Self-clearing if the socket
        // closes or we shut down. This only guards client memory; the server
        // already drops/handles overflow.
        const t = setInterval(() => {
          if (cleaned || w.readyState !== WebSocket.OPEN) { clearInterval(t); return; }
          if (w.bufferedAmount < BACKPRESSURE_LOW) { clearInterval(t); stdout.resume(); }
        }, 25);
      }
    });
  }

  function tailStderr(stderr, name, sink) {
    stderr.on('data', (d) => {
      const s = d.toString();
      sink.text = (sink.text + s).slice(-4096);
      const line = s.trim();
      if (line) warn(`${name} ffmpeg: ${line}`);
    });
  }

  function onFfExit(name, code) {
    if (name === 'video') {
      videoDone = true;
      if (code !== 0 && code !== null) warn(`video ffmpeg exited with code ${code}`);
      else log('video ffmpeg finished');
    } else {
      audioDone = true;
      if (code !== 0 && code !== null) {
        warn(`audio ffmpeg exited with code ${code} — likely no audio stream; continuing video-only`);
      } else {
        log('audio ffmpeg finished');
      }
    }
    if (videoDone && audioDone) finishSuccess();
  }

  const videoArgs = [
    '-hide_banner', '-loglevel', 'error', '-re', '-i', cfg.video,
    '-vf', `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H}`, '-pix_fmt', 'yuv420p',
    '-r', String(VIDEO_FPS), '-f', 'rawvideo', 'pipe:1',
  ];
  const audioArgs = [
    '-hide_banner', '-loglevel', 'error', '-re', '-i', cfg.video,
    '-vn', '-ar', String(AUDIO_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
  ];

  const videoErr = { text: '' };
  const audioErr = { text: '' };

  videoFf = spawn('ffmpeg', videoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  audioFf = spawn('ffmpeg', audioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  log('ffmpeg started (video + audio)');

  pipeToWs(videoFf.stdout, videoWs, 'video');
  pipeToWs(audioFf.stdout, audioWs, 'audio');
  tailStderr(videoFf.stderr, 'video', videoErr);
  tailStderr(audioFf.stderr, 'audio', audioErr);

  videoFf.on('error', (e) => abort(`failed to start video ffmpeg: ${e.message} (is ffmpeg on PATH?)`, 1));
  // Audio is optional: a spawn error there should not kill the whole run.
  audioFf.on('error', (e) => { warn(`failed to start audio ffmpeg: ${e.message}`); onFfExit('audio', 1); });

  videoFf.on('exit', (code) => onFfExit('video', code));
  audioFf.on('exit', (code) => onFfExit('audio', code));

  progressTimer = setInterval(() => {
    if (cleaned) return;
    log(`progress: video ${(stats.video / 1048576).toFixed(1)}MB | audio ${(stats.audio / 1048576).toFixed(1)}MB`);
  }, 2000);
}

main().catch((e) => {
  err(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
