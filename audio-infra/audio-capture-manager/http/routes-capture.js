'use strict';

const { instances } = require('../stores');
const { readJsonBody } = require('./helpers');
const { CaptureInstance } = require('../audio/capture');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('http/routes-capture');

/**
 * @openapi
 * /capture/{serial}/start:
 *   post:
 *     tags: [system]
 *     operationId: startCapture
 *     summary: Start the audio-capture pipeline for a serial
 *     description: |
 *       **Live device.** Spawns the FFmpeg process that encodes the emulator's audio sink and
 *       serves it over the `/audio/{serial}` WebSocket. Restarting capture drops any client
 *       currently listening to that stream.
 *
 *       Normally the manager starts this itself at boot; the endpoint exists for manual recovery.
 *       If a pipeline is already running for the serial the call is a no-op and reports
 *       `already_running`.
 *
 *       Note that `/audio/{serial}` refuses to attach when no pipeline exists for the serial
 *       (close code 4004), so a stopped capture stays stopped until something starts it again —
 *       this endpoint, or a manager restart.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CaptureStartRequest' }
 *           example: { sinkIndex: 4 }
 *     responses:
 *       '200':
 *         description: Pipeline started, or already running.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CaptureActionResult' }
 *             examples:
 *               started:
 *                 value: { status: started, serial: 'emulator-test3:5555', sinkName: emu_audio_4, state: starting, clients: 0 }
 *               alreadyRunning:
 *                 value: { status: already_running, serial: 'emulator-test3:5555', sinkName: emu_audio_4, state: running, clients: 1 }
 *       '400':
 *         description: '`sinkIndex` missing, or the body is not valid JSON.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorWithReason' }
 *             example: { error: 'sinkIndex required' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /capture/{serial}/stop:
 *   post:
 *     tags: [system]
 *     operationId: stopCapture
 *     summary: Stop the audio-capture pipeline for a serial
 *     description: |
 *       **Live device.** Terminates the FFmpeg process and closes every WebSocket client attached
 *       to that audio stream. The pipeline does not come back on its own: `/audio/{serial}` will
 *       refuse new listeners with close code 4004 until capture is started again.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Pipeline stopped.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CaptureActionResult' }
 *             example: { status: stopped, serial: 'emulator-test3:5555' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/Forbidden' }
 *       '404':
 *         description: No capture pipeline is running for that serial.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorWithReason' }
 *             example: { error: 'not found' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
// The serial lives in the path, like every other per-device route here. It used to
// arrive in the body, and that put these two endpoints outside the ownership check
// entirely: the middleware reads the serial from the URL, found none, and let the
// request through — a non-owner could stop the audio capture on someone else's
// booked device. Keeping the serial in the path is what makes the middleware cover
// them, so it stays there.
function handleCapture(req, res, url) {
    const startMatch = url.pathname.match(/^\/api\/capture\/(.+)\/start$/);
    if (req.method === 'POST' && startMatch) {
        const serial = decodeURIComponent(startMatch[1]);
        readJsonBody(req).then(({ sinkIndex }) => {
            if (!sinkIndex) { res.writeHead(400); res.end(JSON.stringify({ error: 'sinkIndex required' })); return; }
            if (!isSerialAllowed(serial)) {
                log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
                return;
            }
            if (instances.has(serial)) {
                const existing = instances.get(serial);
                if (existing.state === 'running') {
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'already_running', ...existing.toJSON() }));
                    return;
                }
                existing.stop();
            }
            const instance = new CaptureInstance(serial, sinkIndex);
            instances.set(serial, instance);
            instance.start();
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'started', ...instance.toJSON() }));
        }).catch((err) => { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
        return true;
    }

    const stopMatch = url.pathname.match(/^\/api\/capture\/(.+)\/stop$/);
    if (req.method === 'POST' && stopMatch) {
        const serial = decodeURIComponent(stopMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const instance = instances.get(serial);
        if (!instance) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return true; }
        instance.stop();
        instances.delete(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'stopped', serial }));
        return true;
    }

    return false;
}

module.exports = { handleCapture };
