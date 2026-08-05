'use strict';

const { getBtState, setBt } = require('../domain/bluetooth');
const log = require('../log').getLogger('http/routes-bluetooth');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /bluetooth/{serial}:
 *   get:
 *     tags: [network]
 *     operationId: getBluetooth
 *     summary: Read the Bluetooth adapter state
 *     description: |
 *       Reads `dumpsys bluetooth_manager` and reports the adapter's first `state:` token
 *       (`ON`, `OFF`, `TURNING_ON`, `TURNING_OFF`, `BLE_ON`, ...). `enabled` is true only when
 *       the state is exactly `ON`, so a device mid-transition comes back `enabled: false` with a
 *       `TURNING_ON` state.
 *
 *       Read-only, no root needed; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current adapter state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BluetoothState' }
 *             example: { ok: true, enabled: true, state: ON }
 *       '400':
 *         description: The dumpsys read failed (device offline or adb unavailable).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'device offline' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [network]
 *     operationId: setBluetooth
 *     summary: Turn the Bluetooth adapter on or off
 *     description: |
 *       **Live device.** Flips the real adapter with `su 0 cmd bluetooth_manager enable|disable`.
 *       Turning it off drops any Bluetooth connection the device has, and BLE beacon scanning
 *       stops working — try-it-out on an instance somebody is using is visible to them.
 *
 *       **Takes up to about 4 seconds.** The adapter goes through `TURNING_ON`/`TURNING_OFF`, so
 *       after issuing the command the handler polls the state up to 6 times at 700 ms intervals
 *       and only answers once it settles (or the budget runs out). Size client timeouts above
 *       that. If the state never reaches the requested one the call still returns `200` with the
 *       state actually observed — compare `enabled` with what you asked for.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BluetoothRequest' }
 *           examples:
 *             enable:
 *               summary: Turn the adapter on
 *               value: { enabled: true }
 *             disable:
 *               summary: Turn the adapter off
 *               value: { enabled: false }
 *     responses:
 *       '200':
 *         description: |
 *           The settled adapter state after the toggle. A transitional `state` means the adapter
 *           had not finished switching within the polling budget.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BluetoothState' }
 *             example: { ok: true, enabled: true, state: ON }
 *       '400':
 *         description: |
 *           `enabled` is missing or not a boolean, or the adb command failed. Strings such as
 *           `"true"` are rejected.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'enabled must be a boolean' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleBluetooth(req, res, url) {
    const match = url.pathname.match(/^\/api\/bluetooth\/(.+)$/);
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
        getBtState(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read bluetooth state');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                if (typeof body.enabled !== 'boolean') {
                    throw new Error('enabled must be a boolean');
                }
                const state = await setBt(serial, body.enabled);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set bluetooth state');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleBluetooth };
