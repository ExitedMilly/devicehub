'use strict';

const { applyCellTower, resetCellTower, getCellTowerStatus } = require('../domain/cell-tower');
const log = require('../log').getLogger('http/routes-cell-tower');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// GET    /api/cell-tower/<serial>  -> current spoof + pinned operator + live serving cell
// POST   /api/cell-tower/<serial>  -> apply { cid, lac, tac?, rat, neighbors? } (operator pinned)
// DELETE /api/cell-tower/<serial>  -> clear spoof (back to stock)
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
