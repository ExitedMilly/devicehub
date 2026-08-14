'use strict';

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Percent-decode without throwing, falling back to the raw value.
 * decodeURIComponent raises URIError on a malformed escape ("%zz", "%2", a
 * lone "%"), and every caller here sits on a request path where an exception
 * is worse than a bad string.
 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (err) {
        return value;
    }
}

/**
 * Whether a pathname can be percent-decoded at all.
 *
 * Route handlers capture a path segment and call decodeURIComponent on it — 42
 * call sites, none of them guarded. A malformed escape therefore threw URIError
 * inside the server's async callback, and with no unhandledRejection handler
 * that took down the whole manager, not just the request. Checking the whole
 * pathname once, before any handler runs, covers all of them: a "%XX" triple
 * cannot straddle a "/" boundary (an encoded slash is "%2F", not a literal
 * one), so if the full pathname decodes then every segment a handler can
 * capture decodes too.
 */
function isDecodablePath(pathname) {
    try {
        decodeURIComponent(pathname);
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { readJsonBody, safeDecode, isDecodablePath };
