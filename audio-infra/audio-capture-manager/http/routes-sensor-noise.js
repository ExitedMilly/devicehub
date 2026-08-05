'use strict';

const sensorNoise = require('../domain/sensor-noise');
const log = require('../log').getLogger('http/routes-sensor-noise');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /sensor-noise/{serial}:
 *   get:
 *     tags: [sensors]
 *     operationId: getSensorNoise
 *     summary: Read the state of the realistic-sensor noise loop
 *     description: |
 *       Returns whether the noise loop is running for this serial and, when it is, which scenario
 *       resources are currently `owned` by an operblock, which sensors are therefore `skipped`,
 *       the tick cadence, when it started, when it last ticked and the last tick error (null while
 *       healthy).
 *
 *       When the loop is not running the body is just `{ "ok": true, "active": false }` — no other
 *       fields are present.
 *
 *       Read-only, in-memory; safe to poll. State does not survive a manager restart.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current loop state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SensorNoiseState' }
 *             examples:
 *               running:
 *                 summary: Running, with the light operblock holding its sensor
 *                 value:
 *                   ok: true
 *                   active: true
 *                   serial: 'emulator-test3:5555'
 *                   owned: [light]
 *                   skipped: [light]
 *                   sensors: 12
 *                   tickMs: 350
 *                   startedAt: '2026-07-31T10:14:00.100Z'
 *                   lastTickAt: 1785492904512
 *                   lastError: null
 *               stopped:
 *                 summary: Not running
 *                 value: { ok: true, active: false }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [sensors]
 *     operationId: setSensorNoise
 *     summary: Start or stop the realistic-sensor noise loop, or update its owned resources
 *     description: |
 *       **Live device.** Starts or stops a background loop that keeps writing every sensor on the
 *       running emulator so none of them sit at the tell-tale emulator defaults (gyroscope 0:0:0,
 *       temperature 0, humidity 0, light 0). While active it writes 12 sensors — accelerometer,
 *       gyroscope, magnetic field, orientation, temperature, proximity, light, pressure, humidity
 *       and the three uncalibrated variants — every 350 ms over one authenticated emulator-console
 *       connection per tick, each value being a fixed realistic base plus fresh jitter (so there is
 *       no random-walk drift). Try-it-out on an instance somebody is using will move their sensors
 *       continuously until it is stopped.
 *
 *       **`owned` decides which sensors the loop leaves alone.** It is the list of scenario
 *       resources currently held by an operblock, and the loop skips the sensors those resources
 *       drive: `light` -> the light sensor; `pose` -> acceleration, orientation, magnetic-field and
 *       their uncalibrated variants; `temperature`, `humidity`, `pressure` -> the matching ambient
 *       sensors (the last three are what "weather from location" claims). Without this the noise
 *       loop would win — it writes far more often than any operblock, on the same last-write-wins
 *       sensor layer — and the operblock's value would be overwritten within a tick. Omitting
 *       `owned`, or sending it as anything other than an array, is treated as "nothing owned":
 *       every sensor is jittered.
 *
 *       **The call is idempotent and doubles as an ownership update.** With `enabled: true` on a
 *       serial where the loop is already running, the loop is not restarted — only `owned` is
 *       swapped, live, which is how the frontend notifies the loop that an operblock started or
 *       stopped. With `enabled: false` the loop is stopped and the sensors keep whatever value the
 *       last tick left; stopping an already-stopped loop is not an error.
 *
 *       Returns immediately — the loop runs in the background; a failing tick is reported through
 *       `lastError` on the GET, not through this response.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SensorNoiseRequest' }
 *           examples:
 *             start:
 *               summary: Start with nothing owned — every sensor jitters
 *               value: { enabled: true, owned: [] }
 *             startWithOwner:
 *               summary: Start while the light operblock is active
 *               value: { enabled: true, owned: [light] }
 *             updateOwned:
 *               summary: Loop already running — hand it the weather resources
 *               value: { enabled: true, owned: [temperature, humidity, pressure] }
 *             stop:
 *               summary: Stop the loop
 *               value: { enabled: false }
 *     responses:
 *       '200':
 *         description: |
 *           The post-change state, in the same shape as the GET. After a stop it is
 *           `{ "ok": true, "active": false }`.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SensorNoiseState' }
 *             examples:
 *               started:
 *                 value:
 *                   ok: true
 *                   active: true
 *                   serial: 'emulator-test3:5555'
 *                   owned: [light]
 *                   skipped: [light]
 *                   sensors: 12
 *                   tickMs: 350
 *                   startedAt: '2026-07-31T10:14:00.100Z'
 *                   lastTickAt: null
 *                   lastError: null
 *               stopped:
 *                 value: { ok: true, active: false }
 *       '400':
 *         description: |
 *           `enabled` missing or not a boolean (a string `"true"` is rejected), or the body was
 *           not valid JSON.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'enabled must be a boolean' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleSensorNoise(req, res, url) {
    const match = url.pathname.match(/^\/api\/sensor-noise\/(.+)$/);
    if (!match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, ...sensorNoise.getStatus(serial) }));
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then((body) => {
                if (typeof body.enabled !== 'boolean') {
                    throw new Error('enabled must be a boolean');
                }
                // owned = scenario resources currently held by an operblock (e.g.
                // ['light','pose']); noise skips the sensors those drive.
                const owned = Array.isArray(body.owned) ? body.owned : [];
                let state;
                if (body.enabled) {
                    // Running already? just update ownership; else start fresh.
                    if (sensorNoise.isRunning(serial)) {
                        sensorNoise.setOwned(serial, owned);
                        state = sensorNoise.getStatus(serial);
                    } else {
                        state = sensorNoise.start(serial, owned);
                    }
                } else {
                    sensorNoise.stop(serial);
                    state = sensorNoise.getStatus(serial);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set sensor-noise');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleSensorNoise };
