'use strict';

const { applyBattery, getBatteryState } = require('../domain/battery');
const log = require('../log').getLogger('http/routes-battery');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /battery/{serial}:
 *   get:
 *     tags: [device]
 *     operationId: getBattery
 *     summary: Read the current battery level, charging flag, status and health
 *     description: |
 *       Runs `adb shell dumpsys battery` and parses it: `capacity` from the `level:` line,
 *       `charging` true when any power source is on (AC, USB or wireless), `status` and `health`
 *       as the raw Android integers (status 2 = charging, 3 = discharging).
 *
 *       Any field the parser cannot find comes back as `null` rather than failing the call.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current battery state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BatteryState' }
 *             example: { ok: true, capacity: 77, charging: false, status: 3, health: 2 }
 *       '400':
 *         description: The dumpsys read failed — usually the device is offline or not booted.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'device offline' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [device]
 *     operationId: applyBattery
 *     summary: Set the battery level and/or the charging state
 *     description: |
 *       **Live device.** Writes the battery override with `dumpsys battery set` on the running
 *       emulator, so the change is visible to every app on it immediately — the status bar icon,
 *       any battery-aware app under test, and `BatteryManager` reads. Try-it-out on an instance
 *       somebody is using will move their battery.
 *
 *       **Both fields are optional and applied independently.** Send only `level` to change the
 *       percentage and leave the charging state alone, only `charging` to flip the power source and
 *       leave the percentage alone, or both. A body with neither field applies nothing and just
 *       returns the current state.
 *
 *       `level` must be a number between 0 and 100 and is rounded to an integer.
 *
 *       **`charging` forces a whole power-source state, not just a flag.** `true` runs
 *       `set ac 1` followed by `set status 2`, i.e. the device reports itself as charging from AC.
 *       `false` runs `set ac 0`, `set usb 0` and `set status 3`, i.e. all power sources off and
 *       discharging. There is no way to select USB or wireless charging through this endpoint.
 *
 *       **The override is sticky.** `dumpsys battery set` detaches the reported battery from the
 *       real one until `dumpsys battery reset` or an emulator restart, and this API exposes no
 *       reset route — the values stay pinned where you left them.
 *
 *       The response is a fresh `dumpsys battery` read taken after the writes, not an echo of the
 *       request.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/BatteryRequest' }
 *           examples:
 *             lowBattery:
 *               summary: Drain to 15% and unplug
 *               value: { level: 15, charging: false }
 *             levelOnly:
 *               summary: Change the percentage, leave the power source as it is
 *               value: { level: 77 }
 *             plugIn:
 *               summary: Force the AC-charging state
 *               value: { charging: true }
 *     responses:
 *       '200':
 *         description: Applied. The body is the post-apply state, re-read from the device.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BatteryState' }
 *             example: { ok: true, capacity: 15, charging: false, status: 3, health: 2 }
 *       '400':
 *         description: Invalid `level`, or the device could not be written to.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'level must be a number between 0 and 100' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleBattery(req, res, url) {
    const batteryMatch = url.pathname.match(/^\/api\/battery\/(.+)$/);
    if (!batteryMatch) {
        return false;
    }

    const serial = decodeURIComponent(batteryMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        getBatteryState(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...state,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read battery');
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
                const state = await applyBattery(serial, { level: body.level, charging: body.charging });

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...state,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply battery');
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

module.exports = { handleBattery };
