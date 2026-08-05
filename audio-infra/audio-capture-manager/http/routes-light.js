'use strict';

const { setDeviceLight } = require('../domain/light');
const log = require('../log').getLogger('http/routes-light');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /light/{serial}:
 *   post:
 *     tags: [sensors]
 *     operationId: applyLight
 *     summary: Set the ambient light sensor (lux)
 *     description: |
 *       **Live device.** Writes the ambient light level to the running emulator, so anything on
 *       screen that reacts to light (auto-brightness, an app reading `TYPE_LIGHT`) changes
 *       immediately. Try-it-out on an instance somebody is using will change what they see.
 *
 *       **Two write paths, and the response tells you which one ran.** The gRPC physical model
 *       (`setPhysicalModel` on target `LIGHT`) is tried first; after a 250 ms settle the value is
 *       read back through `getPhysicalModel` and `getSensor`. If neither readback lands within
 *       0.01 lux of the requested value — or the gRPC call fails outright — the handler falls back
 *       to the emulator console (`adb emu sensor set light`). `appliedVia` is `physicalModel` or
 *       `adbConsole` accordingly, and on a fallback `fallbackReason` carries the gRPC error that
 *       triggered it. A non-null `fallbackReason` is not a failure; the value was still applied.
 *
 *       On the console path there is no physical-model value to report, so `physicalLux` is null
 *       and only `sensorLux` is filled from `adb emu sensor get light`.
 *
 *       While this operblock holds the `light` scenario resource, the realistic-sensor noise loop
 *       skips the light sensor, so the value set here is not jittered away
 *       (see `POST /sensor-noise/{serial}`).
 *
 *       Returns quickly (sub-second); no daemon restart is involved.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/LightRequest' }
 *           examples:
 *             office:
 *               summary: Office lighting
 *               value: { lux: 300 }
 *             darkness:
 *               summary: Pitch dark (pocket / night)
 *               value: { lux: 0 }
 *     responses:
 *       '200':
 *         description: Applied. The body is the stored light state for this serial.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LightResult' }
 *             examples:
 *               grpc:
 *                 summary: Applied over gRPC
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   lux: 300
 *                   appliedAt: '2026-07-31T10:15:04.512Z'
 *                   appliedVia: physicalModel
 *                   physicalLux: 300
 *                   sensorLux: 300
 *                   fallbackReason: null
 *               fallback:
 *                 summary: gRPC readback mismatch — applied over the adb console instead
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   lux: 300
 *                   appliedAt: '2026-07-31T10:15:04.512Z'
 *                   appliedVia: adbConsole
 *                   physicalLux: null
 *                   sensorLux: 300
 *                   fallbackReason: 'gRPC light readback mismatch: physical=null, sensor=null'
 *       '400':
 *         description: |
 *           Invalid `lux` (not a finite number, or negative), or both the gRPC and the console
 *           path failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               notANumber:
 *                 value: { ok: false, error: 'lux must be a valid number' }
 *               negative:
 *                 value: { ok: false, error: 'lux must be greater than or equal to 0' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleLight(req, res, url) {
    const lightMatch = url.pathname.match(/^\/api\/light\/(.+)$/);
    if (req.method === 'POST' && lightMatch) {
        const serial = decodeURIComponent(lightMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }

        readJsonBody(req)
            .then(async (body) => {
                const result = await setDeviceLight(serial, body.lux);

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply light');
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

module.exports = { handleLight };
