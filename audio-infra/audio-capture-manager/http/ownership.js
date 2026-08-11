'use strict';

const http = require('http');
const {
    DEVICEHUB_API_HOST,
    DEVICEHUB_API_PORT,
    OWNERSHIP_CACHE_TTL_MS,
    OWNERSHIP_REQUEST_TIMEOUT_MS,
} = require('../config');
const log = require('../log').getLogger('ownership');
const { incrCounter } = require('../metrics');

// In-memory positive cache: key = email:serial, value = { expiresAt }
const cache = new Map();

// Serial as it looks once the pathname has been decoded.
const SERIAL_DECODED = /^\/(?:api\/[^/]+|[^/]+)\/([^/]+:[0-9]+)(?:\/.*)?$/;
// The same shape matched against the still-encoded pathname. Needed because
// decoding turns "%2F" into a path separator, which re-segments the path and
// hides the serial from SERIAL_DECODED; here "%2F" stays an ordinary character.
const SERIAL_ENCODED = /^\/(?:api\/[^/]+|[^/]+)\/([^/]+(?::|%3[Aa])[0-9]+)(?:\/.*)?$/;

/**
 * Percent-decode without throwing. A malformed escape ("%zz") makes
 * decodeURIComponent raise URIError, and an exception here would take the
 * ownership check out of the request path entirely — the opposite of what a
 * security check should do when handed garbage. Fall back to the raw value so
 * the caller still gets something to match, and let the route handler reject it.
 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (err) {
        return value;
    }
}

/**
 * Extract serial from URL pathname like:
 *   /api/gps/emulator-test1:5555            → "emulator-test1:5555"
 *   /api/gps/emulator-test1:5555/stop       → "emulator-test1:5555"
 *   /audio/emulator-test1:5555              → "emulator-test1:5555"
 *   /api/backup/emulator-test1:5555/restore → "emulator-test1:5555"
 *
 * The pathname reaches us percent-encoded whenever the client encodes the
 * serial — the frontend builds HTTP URLs with encodeURIComponent, so the colon
 * arrives as "%3A", and nginx forwards the WebSocket routes with the request
 * target untouched. Matching that against a literal colon found nothing, so
 * this returned null, the caller read that as "no serial in this path" and
 * skipped the ownership check altogether. Decode before matching.
 *
 * Returns null if pattern doesn't match.
 */
function extractSerial(pathname) {
    const decoded = safeDecode(pathname).match(SERIAL_DECODED);
    if (decoded) {
        return decoded[1];
    }
    const encoded = pathname.match(SERIAL_ENCODED);
    return encoded ? safeDecode(encoded[1]) : null;
}

/**
 * Behaviour of extractSerial before the decoding fix. Kept only so the
 * transitional mode can tell a request that was already being checked from one
 * the fix newly brings under the check — nothing else should use it.
 */
function extractSerialLegacy(pathname) {
    const match = pathname.match(SERIAL_DECODED);
    return match ? safeDecode(match[1]) : null;
}

function cacheGet(email, serial) {
    const key = `${email}:${serial}`;
    const entry = cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return false;
    }
    return true;
}

function cacheSet(email, serial) {
    const key = `${email}:${serial}`;
    cache.set(key, { expiresAt: Date.now() + OWNERSHIP_CACHE_TTL_MS });
}

/**
 * Round-trip to DeviceHub API to check ownership.
 * Returns one of: 'owns' | 'not-owner' | 'unavailable'
 */
function fetchOwnership(jwt, serial, email) {
    return new Promise((resolve) => {
        const options = {
            host: DEVICEHUB_API_HOST,
            port: DEVICEHUB_API_PORT,
            path: '/api/v1/user/devices/' + encodeURIComponent(serial),
            headers: { authorization: 'Bearer ' + jwt },
            timeout: OWNERSHIP_REQUEST_TIMEOUT_MS,
        };

        const req = http.get(options, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve('owns');
                } else if (res.statusCode === 404 || res.statusCode === 403) {
                    resolve('not-owner');
                } else {
                    log.warn({ email, serial, statusCode: res.statusCode }, 'unexpected status from devicehub-api');
                    resolve('unavailable');
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            log.warn({ email, serial }, 'ownership check timeout');
            resolve('unavailable');
        });

        req.on('error', (err) => {
            log.warn({ email, serial, err: err.message }, 'ownership check error');
            resolve('unavailable');
        });
    });
}

/**
 * Returns one of: 'owns' | 'not-owner' | 'unavailable'
 * Uses positive cache for repeated HTTP requests.
 */
async function checkOwnership(jwt, serial, email) {
    if (cacheGet(email, serial)) {
        incrCounter('capture_mgr_ownership_cache_hits_total');
        incrCounter('capture_mgr_ownership_checks_total', { result: 'owns' });
        return 'owns';
    }
    const result = await fetchOwnership(jwt, serial, email);
    if (result === 'owns') {
        cacheSet(email, serial);
    }
    incrCounter('capture_mgr_ownership_checks_total', { result });
    return result;
}

function getCacheSize() {
    return cache.size;
}

module.exports = { checkOwnership, extractSerial, extractSerialLegacy, getCacheSize };
