'use strict';

const { applyBattery, getBatteryState } = require('../domain/battery');
const log = require('../log').getLogger('http/routes-battery');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleBattery(req, res, url) {
    const batteryMatch = url.pathname.match(/^\/api\/battery\/(.+)$/);
    if (!batteryMatch) {
        return false;
    }

    const serial = decodeURIComponent(batteryMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        getBatteryState(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...state,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read battery');
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
                const state = await applyBattery(serial, { level: body.level, charging: body.charging });

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...state,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply battery');
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

module.exports = { handleBattery };
