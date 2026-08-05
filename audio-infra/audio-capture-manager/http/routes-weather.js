'use strict';

const { applyWeather } = require('../domain/weather');
const log = require('../log').getLogger('http/routes-weather');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST /api/weather/<serial>  { latitude, longitude }
//   Fetch the current weather from Open-Meteo for the coordinates and set the ambient
//   temperature/humidity/pressure sensors via the emulator console. The frontend
//   throttles calls by distance; this endpoint just fetches + applies once.

/**
 * @openapi
 * /weather/{serial}:
 *   post:
 *     tags: [sensors]
 *     operationId: applyWeather
 *     summary: Fetch the real current weather at a coordinate and write it to the sensors
 *     description: |
 *       **Live device.** Fetches the *current* real-world weather for the given coordinates from
 *       the public Open-Meteo API (`api.open-meteo.com/v1/forecast`, no key, no registration) and
 *       writes it straight to the emulator's ambient sensors over the emulator console: air
 *       temperature to `temperature` (°C), relative humidity to `humidity` (%) and surface
 *       pressure to `pressure` (hPa). Open-Meteo's units already match the sensors, so nothing is
 *       converted. Try-it-out on an instance somebody is using will change their sensor readings.
 *
 *       **Humidity and pressure are optional.** Only the fields Open-Meteo actually returns are
 *       written; a missing one is left untouched on the device and reported as null in the
 *       response. A missing `current.temperature_2m` is treated as an upstream failure (502).
 *
 *       **One shot, no polling.** The endpoint fetches and applies once. Continuous "weather from
 *       location" is the caller's job — the frontend throttles by travelled distance — because each
 *       call is a live HTTPS request to a third party.
 *
 *       While the weather owner is active it holds the `temperature`, `humidity` and `pressure`
 *       scenario resources, so the realistic-sensor noise loop skips those three sensors and the
 *       real values are not jittered away (see `POST /sensor-noise/{serial}`). Note that
 *       `POST /temperature/{serial}` writes the same temperature sensor and will overwrite this.
 *
 *       Budget up to ~14 s in the worst case: an 8 s timeout on the Open-Meteo request plus 6 s on
 *       the console call. Typically it is well under a second.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WeatherRequest' }
 *           examples:
 *             moscow:
 *               summary: Red Square
 *               value: { latitude: 55.751244, longitude: 37.618423 }
 *     responses:
 *       '200':
 *         description: |
 *           Fetched and applied. The body carries the values actually written; `humidity` and
 *           `pressure` are null when Open-Meteo did not report them.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WeatherResult' }
 *             example:
 *               ok: true
 *               serial: 'emulator-test3:5555'
 *               latitude: 55.751244
 *               longitude: 37.618423
 *               temp: 18.4
 *               humidity: 62
 *               pressure: 1011.3
 *               appliedAt: '2026-07-31T10:15:04.512Z'
 *       '400':
 *         description: |
 *           Invalid coordinates — `latitude` outside [-90, 90] or `longitude` outside [-180, 180],
 *           or either one missing or not a number.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               badLatitude:
 *                 value: { ok: false, error: 'latitude must be between -90 and 90' }
 *               badLongitude:
 *                 value: { ok: false, error: 'longitude must be between -180 and 180' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '502':
 *         description: |
 *           **The failure is upstream, not in this service.** Everything that is not a coordinate
 *           validation error is reported as 502, and in practice it comes from Open-Meteo: a
 *           non-200 HTTP status, a request that timed out after 8 s, a network error, an
 *           unparseable body, or a payload with no `current.temperature_2m`. The `error` string is
 *           passed through verbatim, so it names Open-Meteo when Open-Meteo is at fault. Retrying
 *           later is the right response; nothing about the device or this manager needs fixing.
 *
 *           The same status also covers a failing emulator-console write once the fetch succeeded
 *           (rarer, and the message will not mention Open-Meteo).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               upstreamStatus:
 *                 summary: Open-Meteo returned a non-200
 *                 value: { ok: false, error: 'Open-Meteo HTTP 429: rate limit exceeded' }
 *               upstreamTimeout:
 *                 summary: Open-Meteo did not answer within 8 s
 *                 value: { ok: false, error: 'Open-Meteo request timed out' }
 *               upstreamShape:
 *                 summary: Answer had no current temperature
 *                 value: { ok: false, error: 'Open-Meteo response missing current.temperature_2m' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleWeather(req, res, url) {
    const match = url.pathname.match(/^\/api\/weather\/(.+)$/);
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
            const result = await applyWeather(serial, body.latitude, body.longitude);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err) => {
            log.error({ serial, err: err.message }, 'Failed to apply weather');
            // 400 for bad input, 502 for an upstream (Open-Meteo / console) failure.
            const badInput = /latitude|longitude/.test(err.message);
            res.writeHead(badInput ? 400 : 502);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });

    return true;
}

module.exports = { handleWeather };
