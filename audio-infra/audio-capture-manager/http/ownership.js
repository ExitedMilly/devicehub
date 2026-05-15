'use strict';

const http = require('http');
const {
    DEVICEHUB_API_HOST,
    DEVICEHUB_API_PORT,
    OWNERSHIP_CACHE_TTL_MS,
    OWNERSHIP_REQUEST_TIMEOUT_MS,
} = require('../config');
const log = require('../log').getLogger('ownership');

// In-memory positive cache: key = email:serial, value = { expiresAt }
const cache = new Map();

/**
 * Extract serial from URL pathname like:
 *   /api/gps/emulator-test1:5555            → "emulator-test1:5555"
 *   /api/gps/emulator-test1:5555/stop       → "emulator-test1:5555"
 *   /audio/emulator-test1:5555              → "emulator-test1:5555"
 *   /api/backup/emulator-test1:5555/restore → "emulator-test1:5555"
 * Returns null if pattern doesn't match.
 */
function extractSerial(pathname) {
    const match = pathname.match(/^\/(?:api\/[^/]+|[^/]+)\/([^/]+:[0-9]+)(?:\/.*)?$/);
    return match ? decodeURIComponent(match[1]) : null;
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
        return 'owns';
    }
    const result = await fetchOwnership(jwt, serial, email);
    if (result === 'owns') {
        cacheSet(email, serial);
    }
    return result;
}

module.exports = { checkOwnership, extractSerial };
