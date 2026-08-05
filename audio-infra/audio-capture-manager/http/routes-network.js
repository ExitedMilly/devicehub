'use strict';

const { applyNetwork, getNetworkStatus } = require('../domain/network');
const log = require('../log').getLogger('http/routes-network');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /network/{serial}:
 *   get:
 *     tags: [network]
 *     operationId: getNetworkStatus
 *     summary: Read the current cellular registration, Wi-Fi and airplane-mode state
 *     description: |
 *       Reads `gsm status` over the emulator telnet console for the voice and data registration
 *       states, then `cmd wifi status` and `settings get global airplane_mode_on` over adb.
 *
 *       `voice` and `data` are whatever the console reported (`home`, `roaming`, `searching`,
 *       `denied`, `unregistered`); they are null when the console output could not be parsed.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current network state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/NetworkStatus' }
 *             example: { ok: true, voice: home, data: home, wifi: true, airplane: false }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [network]
 *     operationId: applyNetwork
 *     summary: Change signal strength, network type, registration, Wi-Fi or airplane mode
 *     description: |
 *       **Live device.** Changes the radio and connectivity state of the running emulator: signal
 *       bars, the reported data technology, the voice/data registration state, the Wi-Fi radio and
 *       airplane mode. Try-it-out on an instance somebody is using will drop their connectivity.
 *
 *       **Every field is optional and only the ones present are applied**, in this fixed order:
 *       `signalProfile`, then `rssi`/`ber`, then `networkType`, then `registration`, then `wifi`,
 *       then `airplane`. An empty body is accepted and changes nothing — the response is then just
 *       a fresh status read.
 *
 *       **Signal strength is driven by RSSI, not by a signal profile.** On this emulator's
 *       modem_simulator the console command `gsm signal-profile` does not hold — the modem snaps
 *       back to full bars right after it is set — so the backend never uses it. `signalProfile`
 *       (0-4 perceived bars) is mapped to an RSSI value through the table `[0, 6, 12, 18, 28]` and
 *       issued as `gsm signal <rssi> 0`, which does hold. Sending `rssi` (0-31) and `ber` (0-7)
 *       directly issues the same command with your own values; note that passing only one of the
 *       pair still sends both, so the missing one is rejected by the validator.
 *
 *       Cellular fields (`signalProfile`, `rssi`, `ber`, `networkType`, `registration`) go through
 *       the emulator telnet console. `wifi` and `airplane` go through adb
 *       (`svc wifi`, `cmd connectivity airplane-mode`).
 *
 *       The response body is a fresh status read taken after the changes were applied, so it
 *       reflects what the device actually reports rather than what was requested.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/NetworkApplyRequest' }
 *           examples:
 *             weakSignal:
 *               summary: One bar of LTE
 *               value: { signalProfile: 1, networkType: lte }
 *             rawRssi:
 *               summary: Exact RSSI and bit error rate
 *               value: { rssi: 12, ber: 0 }
 *             roaming:
 *               summary: Put the device on a roaming network
 *               value: { registration: roaming, networkType: umts }
 *             airplane:
 *               summary: Airplane mode on, Wi-Fi off
 *               value: { airplane: true, wifi: false }
 *     responses:
 *       '200':
 *         description: Applied. The body is a fresh status read taken after the changes.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/NetworkStatus' }
 *             example: { ok: true, voice: roaming, data: roaming, wifi: false, airplane: false }
 *       '400':
 *         description: |
 *           A value is out of range or not in the allowed set, or the console/adb command failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               badType:
 *                 value: { ok: false, error: 'networkType must be one of: gsm, hscsd, gprs, edge, umts, hsdpa, lte, evdo, full' }
 *               badRssi:
 *                 value: { ok: false, error: 'rssi must be an integer between 0 and 31' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleNetwork(req, res, url) {
    const networkMatch = url.pathname.match(/^\/api\/network\/(.+)$/);
    if (!networkMatch) {
        return false;
    }

    const serial = decodeURIComponent(networkMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        getNetworkStatus(serial)
            .then((status) => {
                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...status,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read network');
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const status = await applyNetwork(serial, body);

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...status,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply network');
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

module.exports = { handleNetwork };
