'use strict';

const { applyFakeScan, stopFakeScan, getFakeScanState } = require('../domain/fake-scan');
const log = require('../log').getLogger('http/routes-fake-scan');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

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
