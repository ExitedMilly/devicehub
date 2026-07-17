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
