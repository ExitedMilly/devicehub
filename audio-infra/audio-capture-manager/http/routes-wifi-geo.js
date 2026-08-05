'use strict';

const { applyBssidSync, clearBssidSync } = require('../domain/wifi-geo');
const log = require('../log').getLogger('http/routes-wifi-geo');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST   /api/wifi-geo/<serial>  { latitude, longitude }
//   Fetch the location's real BSSIDs from Apple WLOC and inject them into
//   getScanResults() (fake-scan 'location' source, merged with any manual networks).
// DELETE /api/wifi-geo/<serial>   Remove the injected location BSSIDs.
//
// APP-LEVEL ONLY: this changes what apps reading getScanResults() see; it does NOT
// move the system/fused geolocation (see domain/wifi-geo.js header). The frontend
// throttles by distance+age; this endpoint fetches + injects once per call.

/**
 * @openapi
 * /wifi-geo/{serial}:
 *   post:
 *     tags: [network]
 *     operationId: applyWifiGeo
 *     summary: Inject the real Wi-Fi BSSIDs of a coordinate into the scan results
 *     description: |
 *       **Live device.** Fetches the access points Apple's public Wi-Fi location tile service
 *       knows at the given coordinates (the z13 tile containing the point), keeps the **nearest
 *       18**, and injects them into what apps see from `WifiManager.getScanResults()`. RSSI is
 *       derived from the distance to each AP; the tile carries BSSIDs only, so SSIDs are
 *       placeholders (`AP-<last 6 hex of the BSSID>`).
 *
 *       The injection is a separate `location` source, merged with any manually faked networks
 *       (`/fake-scan/{serial}`) instead of replacing them. Calling this again replaces the
 *       previously injected location set.
 *
 *       **App-level only — this does not move the device's location.** It changes only what apps
 *       reading the scan-results API directly see (for example an antifraud check cross-checking
 *       GPS against Wi-Fi). The system/fused location is unaffected: Play Services reads Wi-Fi
 *       through the low-level scanner and GPS dominates the fused fix. Use `/gps/{serial}` to
 *       move the location.
 *
 *       An empty tile (rural coordinates) is a normal `200` with `count: 0`; in that case the
 *       previously injected networks are removed rather than replaced with fakes.
 *
 *       The caller is expected to throttle — the UI refetches by distance and age of the last
 *       fetch, not on every position update.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WifiGeoRequest' }
 *           examples:
 *             moscow:
 *               summary: Red Square
 *               value: { latitude: 55.751244, longitude: 37.618423 }
 *     responses:
 *       '200':
 *         description: |
 *           Networks injected. `count` is how many were injected (at most 18), `total` how many
 *           the tile returned, `nearestM` the distance to the closest one.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WifiGeoResult' }
 *             examples:
 *               injected:
 *                 summary: Dense urban tile
 *                 value:
 *                   ok: true
 *                   serial: emulator-test3:5555
 *                   latitude: 55.751244
 *                   longitude: 37.618423
 *                   count: 18
 *                   total: 2214
 *                   nearestM: 37
 *               emptyTile:
 *                 summary: No access points in the tile — injected networks are cleared
 *                 value:
 *                   ok: true
 *                   serial: emulator-test3:5555
 *                   latitude: 66.5
 *                   longitude: 94.0
 *                   count: 0
 *                   total: 0
 *       '400':
 *         description: Invalid coordinates.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'latitude must be between -90 and 90' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '502':
 *         description: |
 *           **The failure is Apple's, not ours.** The tile lookup against
 *           `gspe85-ssl.ls.apple.com` returned a non-200, timed out (20 s), or produced a body
 *           that could not be decompressed or decoded. The manager passes the upstream error
 *           through unchanged; retrying later usually works. Injecting the networks onto the
 *           device failing (adb) surfaces here too.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               appleHttpError:
 *                 value: { ok: false, error: 'Apple tile HTTP 503 (0 bytes)' }
 *               appleTimeout:
 *                 value: { ok: false, error: 'Apple tile request timed out' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   delete:
 *     tags: [network]
 *     operationId: clearWifiGeo
 *     summary: Remove the injected location BSSIDs
 *     description: |
 *       **Live device.** Drops the `location` fake-scan source and reapplies what is left, so the
 *       injected access points disappear from `getScanResults()`. Manually faked networks stay
 *       active; if none exist the device returns to its real scan results.
 *
 *       Idempotent — clearing when nothing was injected succeeds.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Cleared. `count` is always 0.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WifiGeoResult' }
 *             example: { ok: true, serial: emulator-test3:5555, count: 0 }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleWifiGeo(req, res, url) {
    const match = url.pathname.match(/^\/api\/wifi-geo\/(.+)$/);
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

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const result = await applyBssidSync(serial, body.latitude, body.longitude);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...result }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply BSSID sync');
                const badInput = /latitude|longitude/.test(err.message);
                res.writeHead(badInput ? 400 : 502);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'DELETE') {
        clearBssidSync(serial)
            .then((result) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...result }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to clear BSSID sync');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleWifiGeo };
