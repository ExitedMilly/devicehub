'use strict';

const { instances } = require('../stores');
const { readJsonBody } = require('./helpers');
const { CaptureInstance } = require('../audio/capture');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('http/routes-capture');

/**
 * @openapi
 * /capture/start:
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
 *       **Known discrepancy — read before relying on this in a shared deployment.** The serial is
 *       taken from the request *body*, not from the path. The ownership middleware only extracts a
 *       serial from the URL, so this route is covered by the Bearer check but **not** by the
 *       per-device ownership check that serial-in-path routes get. In SINGLE_MODE the
 *       `isSerialAllowed` guard still restricts it to this manager's own emulator, which is what
 *       limits the blast radius today. Tracked separately; not changed as part of documenting it.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CaptureStartRequest' }
 *           example: { serial: 'emulator-test3:5555', sinkIndex: 4 }
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
 *         description: '`serial` or `sinkIndex` missing, or the body is not valid JSON.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorWithReason' }
 *             example: { error: 'serial and sinkIndex required' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *
 * /capture/stop:
 *   post:
 *     tags: [system]
 *     operationId: stopCapture
 *     summary: Stop the audio-capture pipeline for a serial
 *     description: |
 *       **Live device.** Terminates the FFmpeg process and closes every WebSocket client attached
 *       to that audio stream.
 *
 *       **Same known discrepancy as `/capture/start`:** the serial arrives in the body, so the
 *       per-device ownership check does not run for this route (the Bearer check and, in
 *       SINGLE_MODE, the `isSerialAllowed` guard still do). Documented as-is; not changed here.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CaptureStopRequest' }
 *           example: { serial: 'emulator-test3:5555' }
 *     responses:
 *       '200':
 *         description: Pipeline stopped.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CaptureActionResult' }
 *             example: { status: stopped, serial: 'emulator-test3:5555' }
 *       '400':
 *         description: '`serial` missing, or the body is not valid JSON.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorWithReason' }
 *             example: { error: 'serial required' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '404':
 *         description: No capture pipeline is running for that serial.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorWithReason' }
 *             example: { error: 'not found' }
 */
function handleCapture(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/capture/start') {
        readJsonBody(req).then(({ serial, sinkIndex }) => {
            if (!serial || !sinkIndex) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial and sinkIndex required' })); return; }
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

    if (req.method === 'POST' && url.pathname === '/api/capture/stop') {
        readJsonBody(req).then(({ serial }) => {
            if (!serial) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial required' })); return; }
            if (!isSerialAllowed(serial)) {
                log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
                return;
            }
            const instance = instances.get(serial);
            if (!instance) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
            instance.stop();
            instances.delete(serial);
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'stopped', serial }));
        }).catch((err) => { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
        return true;
    }

    return false;
}

module.exports = { handleCapture };
