'use strict';

const { setProxy, clearProxy, getProxy, resolveHostAddress } = require('../domain/proxy');
const log = require('../log').getLogger('http/routes-proxy');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleProxy(req, res, url) {
    // GET /api/proxy/<serial>/host-address -> auto-detected host proxy address.
    const hostAddrMatch = url.pathname.match(/^\/api\/proxy\/([^/]+)\/host-address$/);
    // GET|POST|DELETE /api/proxy/<serial> (serial has no slash).
    const proxyMatch = url.pathname.match(/^\/api\/proxy\/([^/]+)$/);
    if (!hostAddrMatch && !proxyMatch) {
        return false;
    }

    const serial = decodeURIComponent((hostAddrMatch || proxyMatch)[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (hostAddrMatch && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, hostAddress: resolveHostAddress() }));
        return true;
    }

    if (proxyMatch && req.method === 'GET') {
        getProxy(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (proxyMatch && req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await setProxy(serial, body.host, body.port);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (proxyMatch && req.method === 'DELETE') {
        clearProxy(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to clear proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleProxy };
