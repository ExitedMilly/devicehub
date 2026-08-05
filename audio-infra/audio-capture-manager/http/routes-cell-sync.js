'use strict';

const { applyCellSync } = require('../domain/cell-geo-sync');
const log = require('../log').getLogger('http/routes-cell-sync');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST /api/cell-sync/<serial>  { latitude, longitude }
//   Find the nearest real LTE tower of the instance's operator to the coordinates
//   and set it as the serving cell (setprop + RIL restart, ~7s). The frontend
//   throttles by distance (a RIL restart per apply is expensive); this endpoint
//   looks up + applies once, and no-ops when the nearest tower is unchanged.

/**
 * @openapi
 * /cell-sync/{serial}:
 *   post:
 *     tags: [cell]
 *     operationId: syncCellToLocation
 *     summary: Set the serving cell to the nearest real LTE tower at a coordinate
 *     description: |
 *       **Live device.** Looks up the nearest real LTE tower to the given coordinates in the
 *       offline OpenCelliD database, filtered to this instance's operator, and applies it as the
 *       serving cell. Requires the tower DB to be mounted (`cell_geo: true`, `CELL_GEO_DB`).
 *
 *       **`changed: false` is a normal result, not an error.** Before applying, the backend
 *       compares the nearest tower's CID with the one already set. If they match it returns
 *       immediately with `changed: false` and `reason: "already on nearest tower"`, skipping the
 *       ~7 s RIL restart. That same-cid gate is what makes continuous location sync affordable:
 *       during a walk most throttled calls resolve to the cell that is already active. A location
 *       with no tower within roughly 60 km likewise returns `changed: false` with
 *       `reason: "no tower found near location"`.
 *
 *       **Timing depends on the outcome:** about 6-7 seconds when `changed` is true (the RIL
 *       daemon is restarted), roughly 300 ms when it is false. Size client timeouts for the slow
 *       path.
 *
 *       Only the serving cell is synced. Neighbours are not, because the framework refreshes the
 *       neighbour list only on a full reboot.
 *
 *       The caller is expected to throttle. The UI fires this at most once per 1.5 km of movement.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CellSyncRequest' }
 *           examples:
 *             moscow:
 *               summary: Red Square
 *               value: { latitude: 55.751244, longitude: 37.618423 }
 *     responses:
 *       '200':
 *         description: Lookup completed. Inspect `changed` to see whether the cell moved.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CellSyncResult' }
 *             examples:
 *               applied:
 *                 summary: Tower changed (~7 s)
 *                 value:
 *                   ok: true
 *                   changed: true
 *                   cid: 355851
 *                   distanceM: 230
 *                   towerLat: 55.7531
 *                   towerLon: 37.6205
 *                   operator: MTS
 *               skipped:
 *                 summary: Same-cid gate — already on the nearest tower (~300 ms)
 *                 value:
 *                   ok: true
 *                   changed: false
 *                   reason: already on nearest tower
 *                   cid: 355851
 *                   distanceM: 230
 *                   operator: MTS
 *               noTower:
 *                 summary: Nothing within range
 *                 value:
 *                   ok: true
 *                   changed: false
 *                   reason: no tower found near location
 *                   operator: MTS
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
 *           Tower lookup or apply failed — for example the tower DB is not mounted
 *           (`cell_geo` off, or better-sqlite3 missing), or the SIM operator is not ready.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'tower DB unavailable (better-sqlite3 or towers.db missing)' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleCellSync(req, res, url) {
    const match = url.pathname.match(/^\/api\/cell-sync\/(.+)$/);
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
            const result = await applyCellSync(serial, body.latitude, body.longitude);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err) => {
            log.error({ serial, err: err.message }, 'Failed to sync cell to location');
            // 400 for bad input, 502 for a DB / apply failure.
            const badInput = /latitude|longitude/.test(err.message);
            res.writeHead(badInput ? 400 : 502);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });

    return true;
}

module.exports = { handleCellSync };
