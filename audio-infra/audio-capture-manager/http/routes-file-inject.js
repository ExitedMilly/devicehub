'use strict';

const { isSerialAllowed, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS, SAMPLE_RATE } = require('../config');
const { cameraInstances } = require('../stores');
const log = require('../log').getLogger('http/file-inject');

/**
 * @openapi
 * /file-inject/{serial}:
 *   get:
 *     tags: [media-state]
 *     operationId: getFileInjectPreflight
 *     summary: Preflight before streaming a media file into the virtual camera and microphone
 *     description: |
 *       Read-only. Returns the frame geometry and audio sample rate a client must produce, and
 *       reports whether the camera is free. Call this first, then open the
 *       `/file-video/{serial}` and `/file-audio/{serial}` WebSocket channels — those carry the
 *       binary streams and are outside this OpenAPI document.
 *
 *       The camera accepts one producer at a time: if a browser WebRTC session already holds it,
 *       this returns 409 rather than letting the two fight over the device.
 *
 *       Note the error shape here is `{ ok, reason }`, which differs from the `{ ok, error }` used
 *       by most other endpoints, and the 403 it returns for a foreign serial also uses `reason`
 *       instead of the usual `{ error, expected }` body.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Camera is free; use these parameters for the stream.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/FileInjectPreflight' }
 *             example: { ok: true, width: 640, height: 480, fps: 25, sampleRate: 48000 }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403':
 *         description: |
 *           The serial is not the one this manager owns. Note the non-standard body shape.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalseReason' }
 *             example: { ok: false, reason: 'serial not allowed on this instance' }
 *       '409':
 *         description: The camera is already held by an active WebRTC session.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalseReason' }
 *             example: { ok: false, reason: 'camera busy (WebRTC session active)' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
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
