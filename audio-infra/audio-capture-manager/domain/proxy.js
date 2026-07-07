'use strict';

// Runtime HTTP proxy control for the emulator (traffic interception/inspection).
// Toggled live via adb, no restart:
//   on:   su 0 settings put global http_proxy <host>:<port>
//   off:  su 0 settings put global http_proxy :0
//   read: settings get global http_proxy   (":0" or "null" => disabled)
// `su 0` (root) is needed to write a global setting; args are passed argv-safe
// (no local shell), same as wifi-autoconnect.

const fs = require('fs');
const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/proxy');

// The address the emulator guest must use to reach a proxy running on the DOCKER
// HOST (e.g. mitmproxy). The guest's traffic NATs out through the emulator
// container, so the host is the container's docker-network gateway. The manager
// runs in that same network, so ITS default gateway is that very address. Read
// it from /proc/net/route (the row with Destination 00000000; Gateway is a
// little-endian hex IP). NOTE: 10.0.2.2 does NOT work here — that slirp alias
// resolves inside the emulator container's netns, not the docker host.
// For host-side capture the user runs, on the host:
//   mitmproxy/mitmdump --listen-host 0.0.0.0 --listen-port 8888 --set block_global=false
// (0.0.0.0 so the container can reach it; block_global=false so mitmproxy accepts
// the container's non-local source IP).
function resolveHostAddress() {
    try {
        const routes = fs.readFileSync('/proc/net/route', 'utf8');
        for (const line of routes.split('\n')) {
            const cols = line.trim().split(/\s+/);
            // Iface Destination Gateway Flags RefCnt Use Metric Mask ...
            if (cols.length >= 3 && cols[1] === '00000000' &&
                /^[0-9A-Fa-f]{8}$/.test(cols[2]) && cols[2] !== '00000000') {
                const hex = cols[2];
                const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
                    .map((h) => parseInt(h, 16));
                return octets.join('.');
            }
        }
    } catch (err) {
        log.warn({ err: err.message }, 'resolveHostAddress: failed to read default gateway');
    }
    return null;
}

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

module.exports = { getProxy, setProxy, clearProxy, parseProxy, resolveHostAddress };
