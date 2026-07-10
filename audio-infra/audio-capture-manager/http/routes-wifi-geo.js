'use strict';

const { applyBssidSync, clearBssidSync } = require('../domain/wifi-geo');
const log = require('../log').getLogger('http/routes-wifi-geo');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

// POST   /api/wifi-geo/<serial>  { latitude, longitude }
//   Fetch the location's real BSSIDs from Apple WLOC and inject them into
//   getScanResults() (fake-scan 'location' source, merged with any manual networks).
// DELETE /api/wifi-geo/<serial>   Remove the injected location BSSIDs.
//
// APP-LEVEL ONLY: this changes what apps reading getScanResults() see; it does NOT
// move the system/fused geolocation (see domain/wifi-geo.js header). The frontend
// throttles by distance+age; this endpoint fetches + injects once per call.
function handleWifiGeo(req, res, url) {
    const match = url.pathname.match(/^\/api\/wifi-geo\/(.+)$/);
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

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const result = await applyBssidSync(serial, body.latitude, body.longitude);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...result }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply BSSID sync');
                const badInput = /latitude|longitude/.test(err.message);
                res.writeHead(badInput ? 400 : 502);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'DELETE') {
        clearBssidSync(serial)
            .then((result) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...result }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to clear BSSID sync');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleWifiGeo };
