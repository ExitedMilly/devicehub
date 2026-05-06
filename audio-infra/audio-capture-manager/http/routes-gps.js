'use strict';

const { GPS_KEEPALIVE_INTERVAL_MS } = require('../config');
const log = require('../log').getLogger('http/routes-gps');
const { stopGpsKeepAlive, startGpsKeepAlive, setMockGpsLocation } = require('../domain/gps');
const walkSimulator = require('../domain/walk-simulator');
const { readJsonBody } = require('./helpers');

function handleGps(req, res, url) {
    const gpsStopMatch = url.pathname.match(/^\/api\/gps\/(.+)\/stop$/);
    if (req.method === 'POST' && gpsStopMatch) {
        const serial = decodeURIComponent(gpsStopMatch[1]);
        walkSimulator.stopWalk(serial);
        const stopped = stopGpsKeepAlive(serial);

        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            serial,
            stopped,
        }));
        return true;
    }

    const gpsMatch = url.pathname.match(/^\/api\/gps\/(.+)$/);
    if (req.method === 'POST' && gpsMatch) {
        const serial = decodeURIComponent(gpsMatch[1]);
        walkSimulator.stopWalk(serial);

        readJsonBody(req)
            .then(async (body) => {
                const keepAlive = !!body.keepAlive;
                const intervalMs = body.intervalMs || GPS_KEEPALIVE_INTERVAL_MS;

                let result;
                if (keepAlive) {
                    result = await startGpsKeepAlive(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps',
                        intervalMs
                    );
                } else {
                    stopGpsKeepAlive(serial);
                    const onceResult = await setMockGpsLocation(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps'
                    );
                    result = {
                        ...onceResult,
                        keepAlive: false,
                        intervalMs: null,
                    };
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply GPS');
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

module.exports = { handleGps };
