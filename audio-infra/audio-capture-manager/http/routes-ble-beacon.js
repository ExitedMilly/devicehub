'use strict';

const { listBeacons, addBeacon, removeBeacon } = require('../domain/ble-beacon');
const log = require('../log').getLogger('http/routes-ble-beacon');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /ble-beacon/{serial}:
 *   get:
 *     tags: [network]
 *     operationId: listBleBeacons
 *     summary: List the simulated BLE beacons of the instance
 *     description: |
 *       Reads the instance's netsim device list over the container's netsim proxy
 *       (`emulator-<instance>:7682`) and returns every chip of kind `BLUETOOTH_BEACON`, decoded
 *       into a friendly shape (manufacturer and service data as hex, not base64).
 *
 *       Each beacon's `id` is the **netsim chip id** — that is what
 *       `DELETE /ble-beacon/{serial}/{identifier}` takes, alongside the device name.
 *
 *       Read-only. **Requires the op-v3 or newer emulator image** — older images do not run the
 *       proxy that re-exposes netsim outside localhost, and the call fails with 400.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: The beacons currently registered in netsim (empty array when there are none).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BleBeaconList' }
 *             example:
 *               ok: true
 *               beacons:
 *                 - id: 3
 *                   name: OrchidBeacon
 *                   address: 'be:ac:0b:0c:0d:0e'
 *                   scannable: true
 *                   includeDeviceName: true
 *                   advertiseMode: LOW_LATENCY
 *                   intervalMs: null
 *                   txPowerLevel: HIGH
 *                   dbm: null
 *                   manufacturerData: '00ff01020304'
 *                   services: []
 *       '400':
 *         description: |
 *           The netsim proxy is unreachable or timed out — usually an emulator image older than
 *           op-v3, or a stopped container.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example:
 *               ok: false
 *               error: 'netsim proxy unreachable at emulator-test3:7682 (needs the op-v3 image): connect ECONNREFUSED'
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [network]
 *     operationId: addBleBeacon
 *     summary: Add a simulated BLE beacon
 *     description: |
 *       **Live device.** Creates a new advertising BLE beacon in the instance's netsim. Apps
 *       scanning for BLE on that emulator start seeing it immediately, so it is visible to anyone
 *       currently using the instance.
 *
 *       Only `name` is required. `mac` is optional (netsim assigns one when omitted);
 *       `manufacturer_data` and `service_data` are even-length hex and are converted to base64 for
 *       netsim; `service_data` without `service_uuid` is rejected. `tx_power` accepts
 *       `ultra-low|low|medium|high` or an integer dBm between -127 and 127, `interval` accepts
 *       `low-power|balanced|low-latency` or a positive integer in milliseconds and defaults to
 *       `low-latency`.
 *
 *       **A duplicate MAC comes back as a 400.** netsim answers the create with 404 in that case;
 *       the manager reports it as a validation failure, not as a missing route.
 *
 *       The response is the **full beacon list after the insert**, not just the new beacon.
 *
 *       Requires the op-v3 or newer emulator image.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BleBeaconRequest' }
 *           examples:
 *             minimal:
 *               summary: Name only — netsim picks the MAC and the defaults apply
 *               value: { name: OrchidBeacon }
 *             iBeaconLike:
 *               summary: Fixed MAC with manufacturer data and a service UUID
 *               value:
 *                 name: OrchidBeacon
 *                 mac: 'be:ac:0b:0c:0d:0e'
 *                 manufacturer_data: '00ff01020304'
 *                 service_uuid: 0000fe2c-0000-1000-8000-00805f9b34fb
 *                 service_data: aabbcc
 *                 tx_power: high
 *                 interval: low-latency
 *     responses:
 *       '200':
 *         description: Beacon created. The body is the beacon list after the insert.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BleBeaconList' }
 *       '400':
 *         description: |
 *           Validation failure (missing `name`, malformed MAC, odd-length hex, `service_data`
 *           without `service_uuid`), a duplicate MAC, netsim rejecting the payload, or the netsim
 *           proxy being unreachable.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               duplicateMac:
 *                 summary: A beacon with this MAC already exists
 *                 value: { ok: false, error: 'could not create beacon (a beacon with this MAC may already exist)' }
 *               missingName:
 *                 value: { ok: false, error: 'name is required' }
 *               badMac:
 *                 value: { ok: false, error: 'mac must be a MAC address like 02:00:00:00:00:01' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /ble-beacon/{serial}/{identifier}:
 *   delete:
 *     tags: [network]
 *     operationId: removeBleBeacon
 *     summary: Remove a simulated BLE beacon
 *     description: |
 *       **Live device.** Deletes the beacon's chip in netsim, which takes its device with it, so
 *       the beacon stops advertising to apps on that emulator at once.
 *
 *       The identifier is either the numeric netsim chip id (`id` in the list) or the beacon's
 *       device name. A name is resolved to its chip id with an extra list call first; a name that
 *       matches nothing is a 400.
 *
 *       The response is the **full beacon list after the removal**.
 *
 *       Requires the op-v3 or newer emulator image.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *       - $ref: '#/components/parameters/BeaconIdentifier'
 *     responses:
 *       '200':
 *         description: Beacon removed. The body is the beacon list after the removal.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BleBeaconList' }
 *             example: { ok: true, beacons: [] }
 *       '400':
 *         description: |
 *           No beacon with that name, netsim refusing the delete, or the netsim proxy being
 *           unreachable.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'no beacon found named "OrchidBeacon"' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleBleBeacon(req, res, url) {
    // DELETE /api/ble-beacon/<serial>/<name-or-chipId> ; GET|POST /api/ble-beacon/<serial>
    // (serial has no slash, so the trailing segment is the beacon identifier.)
    const delMatch = url.pathname.match(/^\/api\/ble-beacon\/([^/]+)\/(.+)$/);
    const baseMatch = url.pathname.match(/^\/api\/ble-beacon\/([^/]+)$/);
    if (!delMatch && !baseMatch) {
        return false;
    }

    const serial = decodeURIComponent((delMatch || baseMatch)[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    const ok = (beacons) => {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, beacons }));
    };
    const fail = (err) => {
        log.error({ serial, err: err.message }, 'BLE beacon request failed');
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
    };

    if (baseMatch && req.method === 'GET') {
        listBeacons(serial).then(ok).catch(fail);
        return true;
    }

    if (baseMatch && req.method === 'POST') {
        readJsonBody(req)
            .then((body) => addBeacon(serial, body || {}))
            .then(ok)
            .catch(fail);
        return true;
    }

    if (delMatch && req.method === 'DELETE') {
        removeBeacon(serial, decodeURIComponent(delMatch[2])).then(ok).catch(fail);
        return true;
    }

    return false;
}

module.exports = { handleBleBeacon };
