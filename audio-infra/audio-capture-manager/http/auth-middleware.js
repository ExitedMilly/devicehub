'use strict';

const jws = require('jws');
const { STF_SECRET, AUTH_REQUIRED, OWNERSHIP_TRANSITIONAL } = require('../config');
const { checkOwnership, extractSerial, extractSerialLegacy } = require('./ownership');
const log = require('../log').getLogger('http/auth');

const EXEMPT_PATHS = new Set([
    '/api/health',
    '/api/metrics',
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

async function authMiddleware(req, res, url) {
    if (EXEMPT_PATHS.has(url.pathname)) {
        req.user = null;
        return false;
    }

    const token = extractToken(req);
    const result = verifyToken(token);

    if (result.ok) {
        req.user = result.user;
    } else if (AUTH_REQUIRED) {
        log.warn({ url: req.url, reason: result.reason }, 'auth rejected');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', reason: result.reason }));
        return true;
    } else {
        req.user = null;
        return false;
    }

    // Ownership check — only when AUTH_REQUIRED=1 and user is authenticated
    if (!AUTH_REQUIRED) {
        return false;
    }

    const serial = extractSerial(url.pathname);
    if (!serial) {
        // Endpoint without serial param (e.g. /api/capture/status). Allow.
        return false;
    }

    const ownership = await checkOwnership(token, serial, req.user.email);

    if (ownership === 'owns') {
        return false;
    }

    // Transitional mode: this request is only visible to the check because the
    // decoding fix started matching encoded serials. Report what enforcement
    // would have done and let it through, so the change can be measured against
    // real traffic before it starts refusing anything.
    if (OWNERSHIP_TRANSITIONAL && !extractSerialLegacy(url.pathname)) {
        log.warn(
            { url: req.url, email: req.user.email, serial, ownership },
            'ownership would deny'
        );
        return false;
    }

    if (ownership === 'not-owner') {
        log.warn({ url: req.url, email: req.user.email, serial }, 'ownership denied');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', reason: 'you do not own this device' }));
        return true;
    }

    // 'unavailable' — fail closed
    log.warn({ url: req.url, email: req.user.email, serial }, 'ownership check unavailable');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'service unavailable', reason: 'ownership check failed' }));
    return true;
}

module.exports = { authMiddleware, verifyToken, EXEMPT_PATHS };
