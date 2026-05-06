'use strict';

const { setDeviceLight } = require('../domain/light');
const { readJsonBody } = require('./helpers');

function handleLight(req, res, url) {
    const lightMatch = url.pathname.match(/^\/api\/light\/(.+)$/);
    if (req.method === 'POST' && lightMatch) {
        const serial = decodeURIComponent(lightMatch[1]);

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
                console.error('[light] Failed to apply light:', err.message);
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
