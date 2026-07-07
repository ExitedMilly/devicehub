'use strict';

const { listBeacons } = require('../domain/ble-beacon');
const log = require('../log').getLogger('http/routes-ble-beacon');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleBleBeacon(req, res, url) {
    const match = url.pathname.match(/^\/api\/ble-beacon\/(.+)$/);
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
        listBeacons(serial)
            .then((beacons) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, beacons }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to list BLE beacons');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleBleBeacon };
