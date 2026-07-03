'use strict';

const { setNumber, getNumber } = require('../domain/phonenumber');
const log = require('../log').getLogger('http/routes-phonenumber');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handlePhonenumber(req, res, url) {
    const match = url.pathname.match(/^\/api\/phonenumber\/(.+)$/);
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
        getNumber(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read phone number');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await setNumber(serial, body.number);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set phone number');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handlePhonenumber };
