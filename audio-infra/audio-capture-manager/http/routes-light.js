'use strict';

const { setDeviceLight } = require('../domain/light');
const log = require('../log').getLogger('http/routes-light');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleLight(req, res, url) {
    const lightMatch = url.pathname.match(/^\/api\/light\/(.+)$/);
    if (req.method === 'POST' && lightMatch) {
        const serial = decodeURIComponent(lightMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }

        readJsonBody(req)
            .then(async (body) => {
                const result = await setDeviceLight(serial, body.lux);

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply light');
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

module.exports = { handleLight };
