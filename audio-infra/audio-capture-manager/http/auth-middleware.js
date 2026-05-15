'use strict';

const jws = require('jws');
const { STF_SECRET, AUTH_REQUIRED } = require('../config');
const log = require('../log').getLogger('http/auth');

const EXEMPT_PATHS = new Set([
    '/api/health',
]);

function extractToken(req) {
    const header = req.headers.authorization;
    if (!header) return null;
    const parts = header.split(' ');
    if (parts[0] !== 'Bearer' || !parts[1]) return null;
    return parts[1];
}

function verifyToken(token) {
    if (!token) return { ok: false, reason: 'no token' };
    if (!STF_SECRET) return { ok: false, reason: 'server misconfigured: no STF_SECRET' };
    try {
        if (!jws.verify(token, 'HS256', STF_SECRET)) {
            return { ok: false, reason: 'invalid signature' };
        }
        const decoded = jws.decode(token, { json: true });
        if (!decoded || !decoded.payload) {
            return { ok: false, reason: 'malformed token' };
        }
        const { exp } = decoded.header;
        // DeviceHub uses milliseconds for exp (Date.now() + ONE_MONTH)
        if (exp && exp <= Date.now()) {
            return { ok: false, reason: 'expired' };
        }
        const { email, name } = decoded.payload;
        if (!email) {
            return { ok: false, reason: 'no email in token' };
        }
        return { ok: true, user: { email, name: name || email } };
    } catch (err) {
        return { ok: false, reason: 'verify error: ' + err.message };
    }
}

function authMiddleware(req, res, url) {
    if (EXEMPT_PATHS.has(url.pathname)) {
        req.user = null;
        return false;
    }

    const token = extractToken(req);
    const result = verifyToken(token);

    if (result.ok) {
        req.user = result.user;
        return false;
    }

    if (AUTH_REQUIRED) {
        log.warn({ url: req.url, reason: result.reason }, 'auth rejected');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', reason: result.reason }));
        return true;
    }

    req.user = null;
    return false;
}

module.exports = { authMiddleware, verifyToken, EXEMPT_PATHS };
