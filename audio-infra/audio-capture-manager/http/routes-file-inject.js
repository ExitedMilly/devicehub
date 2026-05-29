'use strict';

const { isSerialAllowed, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS, SAMPLE_RATE } = require('../config');
const { cameraInstances } = require('../stores');
const log = require('../log').getLogger('http/file-inject');

function handleFileInject(req, res, url) {
    const match = url.pathname.match(/^\/api\/file-inject\/(.+)$/);
    if (req.method !== 'GET' || !match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);

    if (!isSerialAllowed(serial)) {
        log.info({ serial }, 'file-inject preflight rejected: serial not allowed');
        res.writeHead(403);
        res.end(JSON.stringify({ ok: false, reason: 'serial not allowed on this instance' }));
        return true;
    }

    if (cameraInstances.get(serial)?.client) {
        log.info({ serial }, 'file-inject preflight rejected: camera busy (WebRTC session active)');
        res.writeHead(409);
        res.end(JSON.stringify({ ok: false, reason: 'camera busy (WebRTC session active)' }));
        return true;
    }

    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
        fps: CAMERA_FPS,
        sampleRate: SAMPLE_RATE,
    }));
    return true;
}

module.exports = { handleFileInject };
