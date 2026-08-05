'use strict';

const { applyCellTower, resetCellTower, getCellTowerStatus } = require('../domain/cell-tower');
const log = require('../log').getLogger('http/routes-cell-tower');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// GET    /api/cell-tower/<serial>  -> current spoof + pinned operator + live serving cell
// POST   /api/cell-tower/<serial>  -> apply { cid, lac, tac?, rat, neighbors? } (operator pinned)
// DELETE /api/cell-tower/<serial>  -> clear spoof (back to stock)

/**
 * @openapi
 * /cell-tower/{serial}:
 *   get:
 *     tags: [cell]
 *     operationId: getCellTower
 *     summary: Read the serving-cell spoof, the pinned operator and the live serving cell
 *     description: |
 *       Returns the `persist.vendor.orchid.ril.*` values currently set, the operator pinned to
 *       this instance, and a best-effort read of the live serving cell from
 *       `dumpsys telephony.registry`.
 *
 *       `applied` is true when any spoof property is set. If the dumpsys read fails the call
 *       still succeeds — `serving` is simply absent or partially filled.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current cell state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CellTowerStatus' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [cell]
 *     operationId: applyCellTower
 *     summary: Set the serving cell (CID/LAC/TAC/RAT) and optional neighbours
 *     description: |
 *       **Live device.** Writes the spoof properties over `adb root` + `setprop`, then restarts
 *       the RIL daemon (`setprop ctl.restart vendor.ril-daemon`) so the framework re-acquires the
 *       cell. Try-it-out on an instance somebody is using will move their serving cell.
 *
 *       **Takes about 6-7 seconds** — the handler waits out a fixed 7 s settle after the restart.
 *       Give clients a timeout above that; the UI uses 20 s. Telephony stays registered across
 *       the restart (a brief radio blip, calls and SMS keep working).
 *
 *       **Serving cell changes live; neighbours do not.** `cid`/`lac`/`tac`/`rat` take effect as
 *       soon as the daemon comes back. The neighbour list is cached harder by the framework and
 *       only refreshes on a **full device reboot**, so `neighbors` set here appears after the next
 *       reboot, not now.
 *
 *       **The operator is bound to the instance.** The op-shim bakes the operator name into the
 *       SIM profile at container creation and there is no runtime path to change it, so MCC/MNC
 *       are pinned to `gsm.sim.operator.numeric`. Sending an `mcc`/`mnc` that differs from the
 *       pinned operator is rejected with 400. To change operator, recreate the instance with a
 *       different `op_*` in `instances.yaml`.
 *
 *       Requires the op-v4 or newer emulator image (the property-driven RIL is baked there).
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CellTowerApplyRequest' }
 *           examples:
 *             lte:
 *               summary: LTE cell, no neighbours
 *               value: { cid: 355851, lac: 17771, tac: 17771, rat: lte }
 *             withNeighbors:
 *               summary: With neighbours (visible only after a reboot)
 *               value:
 *                 cid: 355851
 *                 lac: 17771
 *                 rat: lte
 *                 neighbors: '355852:17771:20,355853:17771:15'
 *     responses:
 *       '200':
 *         description: Applied. The body is the post-apply state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CellTowerStatus' }
 *       '400':
 *         description: |
 *           Validation failure, or an operator that does not match the pinned one, or the SIM
 *           not being ready yet.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               operatorPinned:
 *                 value:
 *                   ok: false
 *                   error: 'operator is bound to this instance (25001); to change it, recreate the instance with a different op_*'
 *               badCid:
 *                 value: { ok: false, error: 'cid must be an integer between 0 and 268435455' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   delete:
 *     tags: [cell]
 *     operationId: resetCellTower
 *     summary: Clear the spoof and return the device to its stock cell
 *     description: |
 *       **Live device.** Clears every property this module owns
 *       (`cid`, `lac`, `tac`, `mcc`, `mnc`, `mnclen`, `rat`, `neighbors`) and restarts the RIL
 *       daemon, so the emulator falls back to its stock cell identity.
 *
 *       **Takes about 6-7 seconds**, same restart path as the POST.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Cleared. The body is the post-reset state, with `applied` false.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CellTowerStatus' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleCellTower(req, res, url) {
    const match = url.pathname.match(/^\/api\/cell-tower\/([^/]+)$/);
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
        getCellTowerStatus(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read cell tower');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await applyCellTower(serial, body);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply cell tower');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'DELETE') {
        resetCellTower(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to reset cell tower');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleCellTower };
