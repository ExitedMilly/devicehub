'use strict';

const { setDeviceTemperature } = require('../domain/temperature');
const log = require('../log').getLogger('http/routes-temperature');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST /api/temperature/<serial>  { celsius: number }
//   Set the ambient temperature sensor (°C) via the emulator console.

/**
 * @openapi
 * /temperature/{serial}:
 *   post:
 *     tags: [sensors]
 *     operationId: applyTemperature
 *     summary: Set the ambient temperature sensor (°C)
 *     description: |
 *       **Live device.** Sets the ambient temperature sensor on the running emulator over the
 *       emulator console (`sensor set temperature <value>`, then `sensor get temperature` to read
 *       the value back). Anything on the device reading `TYPE_AMBIENT_TEMPERATURE` sees the new
 *       value at once.
 *
 *       **Set and hold.** This is a one-shot write, not a loop — the value stays until something
 *       else writes the same sensor. The console and the gRPC physical model share one sensor
 *       layer, last write wins, so the hold is enforced by the scenario resource model rather than
 *       by re-writing: while this operblock is active it owns the `temperature` resource and the
 *       realistic-sensor noise loop skips that sensor instead of jittering it back to its ~25 °C
 *       base (see `POST /sensor-noise/{serial}`). Note that `POST /weather/{serial}` writes the
 *       same sensor and will overwrite this value.
 *
 *       Accepted range is -50 to 100 °C — deliberately wider than anything realistic, so the UI
 *       can constrain it further. The console call has a 6 s timeout.
 *
 *       `sensorTemp` is the read-back value and may be null if the console reply could not be
 *       parsed; that does not mean the write failed.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/TemperatureRequest' }
 *           examples:
 *             roomTemperature:
 *               summary: Room temperature
 *               value: { celsius: 25 }
 *             freezing:
 *               summary: Below zero
 *               value: { celsius: -12.5 }
 *     responses:
 *       '200':
 *         description: Applied. `sensorTemp` is what the device reported back.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TemperatureResult' }
 *             example:
 *               ok: true
 *               serial: 'emulator-test3:5555'
 *               celsius: 25
 *               appliedAt: '2026-07-31T10:15:04.512Z'
 *               appliedVia: console
 *               sensorTemp: 25
 *       '400':
 *         description: |
 *           Invalid `celsius` (not a finite number, or outside [-50, 100]), or the emulator
 *           console call failed or timed out.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               notANumber:
 *                 value: { ok: false, error: 'celsius must be a valid number' }
 *               outOfRange:
 *                 value: { ok: false, error: 'celsius must be within [-50, 100]' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleTemperature(req, res, url) {
    const match = url.pathname.match(/^\/api\/temperature\/(.+)$/);
    if (req.method !== 'POST' || !match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    readJsonBody(req)
        .then(async (body) => {
            const result = await setDeviceTemperature(serial, body.celsius);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err) => {
            log.error({ serial, err: err.message }, 'Failed to apply temperature');
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });

    return true;
}

module.exports = { handleTemperature };
