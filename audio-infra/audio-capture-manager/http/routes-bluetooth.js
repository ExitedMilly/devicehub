'use strict';

const { getBtState, setBt } = require('../domain/bluetooth');
const log = require('../log').getLogger('http/routes-bluetooth');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

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
