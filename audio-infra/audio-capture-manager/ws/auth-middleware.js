'use strict';

const { URL } = require('url');
const { verifyToken } = require('../http/auth-middleware');
const { checkOwnership, extractSerial, extractSerialLegacy } = require('../http/ownership');
const { isDecodablePath } = require('../http/helpers');
const { AUTH_REQUIRED, OWNERSHIP_TRANSITIONAL } = require('../config');
const log = require('../log').getLogger('ws/auth');

function extractTokenFromSubprotocol(req) {
    const proto = req.headers['sec-websocket-protocol'];
    if (!proto) return null;
    // Subprotocol may contain multiple values separated by ", " — take first
    const first = proto.split(',')[0].trim();
    if (!first.startsWith('access_token.')) return null;
    return first.slice('access_token.'.length);
}

async function verifyWsAuth(req) {
    // Same gate as the HTTP middleware, and for the same reason: the WS route
    // handlers decode the captured serial too. 4000 is the code ws/server.js
    // already uses for a path it cannot serve.
    if (!isDecodablePath(new URL(req.url, 'http://localhost').pathname)) {
        log.warn({ path: req.url }, 'WS malformed percent-encoding in path');
        return { ok: false, reason: 'malformed path', closeCode: 4000 };
    }

    const token = extractTokenFromSubprotocol(req);
    const result = verifyToken(token);

    if (!result.ok) {
        if (AUTH_REQUIRED) {
            log.warn({ path: req.url, reason: result.reason }, 'WS auth rejected');
            return { ok: false, reason: result.reason, closeCode: 4001 };
        }
        return { ok: true, user: null };
    }

    // Ownership check — only when AUTH_REQUIRED=1
    if (!AUTH_REQUIRED) {
        return { ok: true, user: result.user };
    }

    const url = new URL(req.url, 'http://localhost');
    const serial = extractSerial(url.pathname);
    if (!serial) {
        return { ok: true, user: result.user };
    }

    const ownership = await checkOwnership(token, serial, result.user.email);

    if (ownership === 'owns') {
        return { ok: true, user: result.user };
    }

    // See the same branch in http/auth-middleware.js — measure before refusing.
    if (OWNERSHIP_TRANSITIONAL && !extractSerialLegacy(url.pathname)) {
        log.warn(
            { path: req.url, email: result.user.email, serial, ownership },
            'WS ownership would deny'
        );
        return { ok: true, user: result.user };
    }

    if (ownership === 'not-owner') {
        log.warn({ path: req.url, email: result.user.email, serial }, 'WS ownership denied');
        return { ok: false, reason: 'forbidden', closeCode: 4003 };
    }
    // 'unavailable'
    log.warn({ path: req.url, email: result.user.email, serial }, 'WS ownership unavailable');
    return { ok: false, reason: 'unavailable', closeCode: 4503 };
}

module.exports = { verifyWsAuth };
