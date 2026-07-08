'use strict';

const sensorNoise = require('../domain/sensor-noise');
const log = require('../log').getLogger('http/routes-sensor-noise');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleSensorNoise(req, res, url) {
    const match = url.pathname.match(/^\/api\/sensor-noise\/(.+)$/);
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
        res.end(JSON.stringify({ ok: true, ...sensorNoise.getStatus(serial) }));
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then((body) => {
                if (typeof body.enabled !== 'boolean') {
                    throw new Error('enabled must be a boolean');
                }
                // owned = scenario resources currently held by an operblock (e.g.
                // ['light','pose']); noise skips the sensors those drive.
                const owned = Array.isArray(body.owned) ? body.owned : [];
                let state;
                if (body.enabled) {
                    // Running already? just update ownership; else start fresh.
                    if (sensorNoise.isRunning(serial)) {
                        sensorNoise.setOwned(serial, owned);
                        state = sensorNoise.getStatus(serial);
                    } else {
                        state = sensorNoise.start(serial, owned);
                    }
                } else {
                    sensorNoise.stop(serial);
                    state = sensorNoise.getStatus(serial);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set sensor-noise');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleSensorNoise };
