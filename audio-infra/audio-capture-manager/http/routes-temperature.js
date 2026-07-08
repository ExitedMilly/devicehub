'use strict';

const { setDeviceTemperature } = require('../domain/temperature');
const log = require('../log').getLogger('http/routes-temperature');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST /api/temperature/<serial>  { celsius: number }
//   Set the ambient temperature sensor (°C) via the emulator console.
function handleTemperature(req, res, url) {
    const match = url.pathname.match(/^\/api\/temperature\/(.+)$/);
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
            const result = await setDeviceTemperature(serial, body.celsius);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err) => {
            log.error({ serial, err: err.message }, 'Failed to apply temperature');
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });

    return true;
}

module.exports = { handleTemperature };
