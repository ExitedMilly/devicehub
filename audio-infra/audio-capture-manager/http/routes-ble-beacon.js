'use strict';

const { listBeacons, addBeacon, removeBeacon } = require('../domain/ble-beacon');
const log = require('../log').getLogger('http/routes-ble-beacon');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleBleBeacon(req, res, url) {
    // DELETE /api/ble-beacon/<serial>/<name-or-chipId> ; GET|POST /api/ble-beacon/<serial>
    // (serial has no slash, so the trailing segment is the beacon identifier.)
    const delMatch = url.pathname.match(/^\/api\/ble-beacon\/([^/]+)\/(.+)$/);
    const baseMatch = url.pathname.match(/^\/api\/ble-beacon\/([^/]+)$/);
    if (!delMatch && !baseMatch) {
        return false;
    }

    const serial = decodeURIComponent((delMatch || baseMatch)[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    const ok = (beacons) => {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, beacons }));
    };
    const fail = (err) => {
        log.error({ serial, err: err.message }, 'BLE beacon request failed');
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: err.message }));
    };

    if (baseMatch && req.method === 'GET') {
        listBeacons(serial).then(ok).catch(fail);
        return true;
    }

    if (baseMatch && req.method === 'POST') {
        readJsonBody(req)
            .then((body) => addBeacon(serial, body || {}))
            .then(ok)
            .catch(fail);
        return true;
    }

    if (delMatch && req.method === 'DELETE') {
        removeBeacon(serial, decodeURIComponent(delMatch[2])).then(ok).catch(fail);
        return true;
    }

    return false;
}

module.exports = { handleBleBeacon };
