'use strict';

const { applyNetwork, getNetworkStatus } = require('../domain/network');
const log = require('../log').getLogger('http/routes-network');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

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
