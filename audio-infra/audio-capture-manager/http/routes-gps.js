'use strict';

const { GPS_KEEPALIVE_INTERVAL_MS, isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('http/routes-gps');
const { stopGpsKeepAlive, startGpsKeepAlive, setMockGpsLocation } = require('../domain/gps');
const walkSimulator = require('../domain/walk-simulator');
const { readJsonBody } = require('./helpers');

/**
 * @openapi
 * /gps/{serial}:
 *   post:
 *     tags: [gps]
 *     operationId: applyGps
 *     summary: Set the device mock location, optionally holding it with a keepalive
 *     description: |
 *       **Live device.** Moves the emulator's location. Over `adb shell` the handler enables
 *       location, grants `android:mock_location` to uid 2000, registers a test provider
 *       (`gps` by default, or `fused` / `network` / `passive`) and sets its position. Every app
 *       on the device sees the new coordinates immediately.
 *
 *       **Also stops a running walk.** Before anything else the handler calls `stopWalk(serial)`,
 *       so a route simulation started via `/walk/{serial}/start` is torn down (together with the
 *       pose scenario that walk auto-started) and the device stays at the coordinates sent here.
 *       This is deliberate — a manual GPS set always wins over the simulator.
 *
 *       **Without `keepAlive` the fix goes stale after about 20 seconds.** A one-shot mock
 *       location is not refreshed, and Android stops handing it to apps once it ages out. Send
 *       `keepAlive: true` to have the manager re-apply the same point on a timer
 *       (`intervalMs`, default 20000 ms, values below 5000 fall back to the default). Starting a
 *       keepalive replaces any keepalive already running for this serial; sending
 *       `keepAlive: false` stops the running one and applies the point once.
 *
 *       Active keepalive sessions are listed by `GET /gps/status`.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/GpsApplyRequest' }
 *           examples:
 *             once:
 *               summary: Red Square, one-shot (stale after ~20 s)
 *               value: { latitude: 55.751244, longitude: 37.618423 }
 *             held:
 *               summary: Red Square, held by a 20 s keepalive
 *               value: { latitude: 55.751244, longitude: 37.618423, provider: gps, keepAlive: true, intervalMs: 20000 }
 *     responses:
 *       '200':
 *         description: |
 *           Location applied. `keepAlive` and `intervalMs` echo what is now running —
 *           `intervalMs` is null for a one-shot apply, and `startedAt` is present only when a
 *           keepalive was started.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GpsApplyResult' }
 *             examples:
 *               once:
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   provider: gps
 *                   latitude: 55.751244
 *                   longitude: 37.618423
 *                   keepAlive: false
 *                   intervalMs: null
 *               held:
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   provider: gps
 *                   latitude: 55.751244
 *                   longitude: 37.618423
 *                   keepAlive: true
 *                   intervalMs: 20000
 *                   startedAt: '2026-07-31T09:12:44.118Z'
 *       '400':
 *         description: |
 *           Invalid coordinates, a body that is not valid JSON, or an adb step that failed
 *           (for example the test provider could not be registered).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               badLatitude:
 *                 value: { ok: false, error: 'latitude must be between -90 and 90' }
 *               providerFailed:
 *                 value: { ok: false, error: 'failed to add test provider "gps": device offline' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /gps/{serial}/stop:
 *   post:
 *     tags: [gps]
 *     operationId: stopGps
 *     summary: Stop the GPS keepalive (and any running walk) for a serial
 *     description: |
 *       **Live device.** Cancels the keepalive timer for this serial, so the mock location is no
 *       longer re-applied.
 *
 *       **Also stops a running walk.** `stopWalk(serial)` runs first, which ends the route
 *       simulation and tears down the pose scenario the walk auto-started. One call therefore
 *       clears both GPS mechanisms.
 *
 *       **It does not clear the location already set.** The last mock position stays registered
 *       with the test provider and simply ages out — Android treats it as stale after roughly
 *       20 seconds. To put the device somewhere specific, POST that location instead.
 *
 *       Takes no request body. `stopped: false` means there was no keepalive running; that is a
 *       normal result, not an error.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Keepalive stopped, or there was none to stop.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GpsStopResult' }
 *             examples:
 *               stopped:
 *                 summary: A keepalive was running
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: true }
 *               nothingRunning:
 *                 summary: Nothing was running
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: false }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleGps(req, res, url) {
    const gpsStopMatch = url.pathname.match(/^\/api\/gps\/(.+)\/stop$/);
    if (req.method === 'POST' && gpsStopMatch) {
        const serial = decodeURIComponent(gpsStopMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        walkSimulator.stopWalk(serial);
        const stopped = stopGpsKeepAlive(serial);

        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            serial,
            stopped,
        }));
        return true;
    }

    const gpsMatch = url.pathname.match(/^\/api\/gps\/(.+)$/);
    if (req.method === 'POST' && gpsMatch) {
        const serial = decodeURIComponent(gpsMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        walkSimulator.stopWalk(serial);

        readJsonBody(req)
            .then(async (body) => {
                const keepAlive = !!body.keepAlive;
                const intervalMs = body.intervalMs || GPS_KEEPALIVE_INTERVAL_MS;

                let result;
                if (keepAlive) {
                    result = await startGpsKeepAlive(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps',
                        intervalMs
                    );
                } else {
                    stopGpsKeepAlive(serial);
                    const onceResult = await setMockGpsLocation(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps'
                    );
                    result = {
                        ...onceResult,
                        keepAlive: false,
                        intervalMs: null,
                    };
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply GPS');
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return true;
    }

    return false;
}

module.exports = { handleGps };
