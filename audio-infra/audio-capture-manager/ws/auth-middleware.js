'use strict';

const { verifyToken } = require('../http/auth-middleware');
const { AUTH_REQUIRED } = require('../config');
const log = require('../log').getLogger('ws/auth');

function extractTokenFromSubprotocol(req) {
    const proto = req.headers['sec-websocket-protocol'];
    if (!proto) return null;
    // Subprotocol may contain multiple values separated by ", " — take first
    const first = proto.split(',')[0].trim();
    if (!first.startsWith('access_token.')) return null;
    return first.slice('access_token.'.length);
}

function verifyWsAuth(req) {
    const token = extractTokenFromSubprotocol(req);
    const result = verifyToken(token);

    if (result.ok) {
        return { ok: true, user: result.user };
    }

    if (AUTH_REQUIRED) {
        log.warn({ path: req.url, reason: result.reason }, 'WS auth rejected');
        return { ok: false, reason: result.reason };
    }

    return { ok: true, user: null };
}

module.exports = { verifyWsAuth };
