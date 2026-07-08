'use strict';

const { applyWeather } = require('../domain/weather');
const log = require('../log').getLogger('http/routes-weather');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST /api/weather/<serial>  { latitude, longitude }
//   Fetch the current weather from Open-Meteo for the coordinates and set the ambient
//   temperature/humidity/pressure sensors via the emulator console. The frontend
//   throttles calls by distance; this endpoint just fetches + applies once.
function handleWeather(req, res, url) {
    const match = url.pathname.match(/^\/api\/weather\/(.+)$/);
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
            const result = await applyWeather(serial, body.latitude, body.longitude);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err) => {
            log.error({ serial, err: err.message }, 'Failed to apply weather');
            // 400 for bad input, 502 for an upstream (Open-Meteo / console) failure.
            const badInput = /latitude|longitude/.test(err.message);
            res.writeHead(badInput ? 400 : 502);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });

    return true;
}

module.exports = { handleWeather };
