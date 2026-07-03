'use strict';

// Runtime HTTP proxy control for the emulator (traffic interception/inspection).
// Toggled live via adb, no restart:
//   on:   su 0 settings put global http_proxy <host>:<port>
//   off:  su 0 settings put global http_proxy :0
//   read: settings get global http_proxy   (":0" or "null" => disabled)
// `su 0` (root) is needed to write a global setting; args are passed argv-safe
// (no local shell), same as wifi-autoconnect.

const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/proxy');

function validateHost(host) {
    const h = String(host == null ? '' : host).trim();
    if (!h || /\s/.test(h)) {
        throw new Error('host must be a non-empty string without spaces');
    }
    return h;
}

function validatePort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
    }
    return p;
}

// Parse `settings get global http_proxy` -> { enabled, host, port, raw }.
function parseProxy(stdout) {
    const raw = String(stdout || '').trim();
    if (!raw || raw === 'null' || raw === ':0') {
        return { enabled: false, host: null, port: null, raw };
    }
    const idx = raw.lastIndexOf(':');
    const host = idx > -1 ? raw.slice(0, idx) : raw;
    const port = idx > -1 ? Number(raw.slice(idx + 1)) : null;
    if (!host || !Number.isInteger(port) || port < 1) {
        return { enabled: false, host: null, port: null, raw };
    }
    return { enabled: true, host, port, raw };
}

async function getProxy(serial) {
    const result = await runAdb(serial, ['shell', 'settings', 'get', 'global', 'http_proxy']);
    return parseProxy(result.stdout);
}

async function setProxy(serial, host, port) {
    const h = validateHost(host);
    const p = validatePort(port);
    log.info({ serial, host: h, port: p }, 'Setting HTTP proxy');
    await runAdb(serial, ['shell', 'su', '0', 'settings', 'put', 'global', 'http_proxy', h + ':' + p]);
    return getProxy(serial);
}

async function clearProxy(serial) {
    log.info({ serial }, 'Clearing HTTP proxy');
    await runAdb(serial, ['shell', 'su', '0', 'settings', 'put', 'global', 'http_proxy', ':0']);
    return getProxy(serial);
}

module.exports = { getProxy, setProxy, clearProxy, parseProxy };
