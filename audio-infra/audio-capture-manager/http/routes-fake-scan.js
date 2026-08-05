'use strict';

const { applyFakeScan, stopFakeScan, getFakeScanState } = require('../domain/fake-scan');
const log = require('../log').getLogger('http/routes-fake-scan');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /fake-scan/{serial}:
 *   get:
 *     tags: [network]
 *     operationId: getFakeScan
 *     summary: Read the manual list of fake Wi-Fi networks
 *     description: |
 *       Returns the manually configured fake-scan list held in the manager's memory, with the
 *       values as they were normalised on apply (auto-generated BSSIDs, defaulted frequency).
 *
 *       **The manual list is only one of two sources.** Wi-Fi geolocation sync
 *       (`POST /wifi-geo/{serial}`) feeds a second, independent list, and the device is shown the
 *       union of both. This endpoint deliberately reports the manual source only, so `faking` can
 *       be false here while the device is still being fed location-synced networks.
 *
 *       State is in-process, so it does not survive a manager restart even if the device is still
 *       faking. Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: The manual fake-scan list.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/FakeScanState' }
 *             examples:
 *               active:
 *                 value:
 *                   ok: true
 *                   faking: true
 *                   networks:
 *                     - { ssid: OrchidNet, security: wpa2, signalDbm: -55, freq: 2412, bssid: '02:00:00:00:00:01' }
 *               empty:
 *                 value: { ok: true, faking: false, networks: [] }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [network]
 *     operationId: applyFakeScan
 *     summary: Replace the manual list of Wi-Fi networks reported to apps
 *     description: |
 *       **Live device.** Replaces the manual fake-scan list and reprograms the running emulator's
 *       Wi-Fi stack (`su 0 cmd wifi reset-fake-scans` / `add-fake-scan` / `start-faking-scans`),
 *       so every app calling `getScanResults()` sees the networks you supply instead of the real
 *       scan. An existing Wi-Fi connection stays up. Try-it-out on an instance somebody is using
 *       will change what their apps see.
 *
 *       **This is a replace, not an append** — whatever was in the manual list before is dropped.
 *       The device is then programmed with the union of the manual list and the location-sync
 *       list, deduplicated by BSSID with manual entries winning a clash.
 *
 *       **An empty or missing `networks` array is a 400**, not a way to clear the list. Use
 *       `DELETE /fake-scan/{serial}` for that.
 *
 *       Per network, `ssid` (1-32 chars, no whitespace), `security` (`open`, `wpa2`, `wpa3`) and
 *       `signalDbm` (-100 to -30) are required and validated. `freq` silently falls back to 2412
 *       when absent or outside 2400-6000. `bssid` is optional: a valid MAC is lower-cased and
 *       used as given, anything else is rejected, and when omitted the backend generates a
 *       locally-administered address from the entry's index (`02:00:00:00:00:01`, `...:02`, ...).
 *
 *       The response body is the resulting manual list, not the merged one the device sees.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/FakeScanRequest' }
 *           examples:
 *             twoNetworks:
 *               summary: A secured and an open network, BSSIDs auto-generated
 *               value:
 *                 networks:
 *                   - { ssid: OrchidNet, security: wpa2, signalDbm: -55 }
 *                   - { ssid: FreeWiFi, security: open, signalDbm: -78 }
 *             explicit:
 *               summary: Fixed BSSID on 5 GHz
 *               value:
 *                 networks:
 *                   - { ssid: LabAP, security: wpa3, signalDbm: -42, freq: 5180, bssid: '02:00:00:00:00:0a' }
 *     responses:
 *       '200':
 *         description: Applied. The body is the resulting manual list.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/FakeScanState' }
 *             example:
 *               ok: true
 *               faking: true
 *               networks:
 *                 - { ssid: OrchidNet, security: wpa2, signalDbm: -55, freq: 2412, bssid: '02:00:00:00:00:01' }
 *                 - { ssid: FreeWiFi, security: open, signalDbm: -78, freq: 2412, bssid: '02:00:00:00:00:02' }
 *       '400':
 *         description: |
 *           `networks` missing, not an array or empty, an entry failed validation, or the
 *           `cmd wifi` call on the device failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               emptyList:
 *                 value: { ok: false, error: 'networks must be a non-empty array' }
 *               badSecurity:
 *                 value: { ok: false, error: 'network[1]: security must be one of open, wpa2, wpa3' }
 *               badSignal:
 *                 value: { ok: false, error: 'network[0]: signalDbm must be an integer between -100 and -30' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   delete:
 *     tags: [network]
 *     operationId: clearFakeScan
 *     summary: Clear the manual list of fake Wi-Fi networks
 *     description: |
 *       **Live device.** Empties the manual list and reprograms the running emulator's Wi-Fi stack
 *       with what is left.
 *
 *       **Faking does not necessarily stop.** If Wi-Fi geolocation sync is still feeding the
 *       location source, the device keeps being fed those networks; only when both sources are
 *       empty does the backend issue `stop-faking-scans` + `reset-fake-scans` + `start-scan` and
 *       let the real scan results come back.
 *
 *       Idempotent — clearing an already-empty list succeeds.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Cleared. The body is the post-clear manual list, always empty.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/FakeScanState' }
 *             example: { ok: true, faking: false, networks: [] }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleFakeScan(req, res, url) {
    const match = url.pathname.match(/^\/api\/fake-scan\/(.+)$/);
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
        res.end(JSON.stringify({ ok: true, ...getFakeScanState(serial) }));
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await applyFakeScan(serial, body && body.networks);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply fake scan');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'DELETE') {
        stopFakeScan(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to stop fake scan');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleFakeScan };
