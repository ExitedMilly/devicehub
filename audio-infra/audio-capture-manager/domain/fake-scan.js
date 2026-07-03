'use strict';

// Runtime fake Wi-Fi scan injection. The user supplies a list of networks
// (SSID / security / signal) and apps on the device see them via
// getScanResults(). Root cmd-wifi mechanism (verified on 36.6):
//   reset-fake-scans
//   add-fake-scan <ssid> <bssid> "<capabilities>" <freq_mhz> <dbm>   (per network)
//   start-faking-scans     (REPLACES the real scan; active connection stays up)
//   stop-faking-scans / reset-fake-scans   (real scan returns)
// `su 0` (root) as in wifi-autoconnect; args reach adb as a single argv element
// (no local shell), and user values are single-quoted for the device shell.

const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/fake-scan');

const SECURITIES = ['open', 'wpa2', 'wpa3'];
const CAPABILITIES = {
    open: '[ESS]',
    wpa2: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
    wpa3: '[RSN-SAE+FT/SAE-CCMP][ESS]',
};
const DEFAULT_FREQ = 2412;

// serial -> { faking, networks } (last applied fake-scan state).
const fakeScanStates = new Map();

// Single-quote a value for the device shell (safe against spaces/brackets/etc).
function shq(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Locally-administered BSSID per index: 02:00:00:00:00:01, ...:02, ...
function bssidFor(index) {
    const last = ((index + 1) & 0xff).toString(16).padStart(2, '0');
    return '02:00:00:00:00:' + last;
}

function validateNetwork(net, index) {
    const ssid = String(net && net.ssid != null ? net.ssid : '').trim();
    if (!ssid || ssid.length > 32 || /\s/.test(ssid)) {
        throw new Error('network[' + index + ']: ssid must be a non-empty string (1-32 chars, no control chars)');
    }
    const security = String((net && net.security) || '').toLowerCase();
    if (!SECURITIES.includes(security)) {
        throw new Error('network[' + index + ']: security must be one of ' + SECURITIES.join(', '));
    }
    const dbm = Number(net && net.signalDbm);
    if (!Number.isInteger(dbm) || dbm < -100 || dbm > -30) {
        throw new Error('network[' + index + ']: signalDbm must be an integer between -100 and -30');
    }
    let freq = Number(net && net.freq);
    if (!Number.isInteger(freq) || freq < 2400 || freq > 6000) freq = DEFAULT_FREQ;
    return { ssid, security, signalDbm: dbm, freq, bssid: bssidFor(index) };
}

// Run a `su 0 cmd wifi ...` command via adb (single argv; no local shell).
function wifiCmd(serial, deviceCommand, opts) {
    return runAdb(serial, ['shell', 'su 0 cmd wifi ' + deviceCommand], opts);
}

async function applyFakeScan(serial, networks) {
    if (!Array.isArray(networks) || networks.length === 0) {
        throw new Error('networks must be a non-empty array');
    }
    const items = networks.map((n, i) => validateNetwork(n, i));

    log.info({ serial, count: items.length }, 'Applying fake Wi-Fi scan');
    await wifiCmd(serial, 'reset-fake-scans', { allowFailure: true });
    for (const v of items) {
        await wifiCmd(
            serial,
            'add-fake-scan ' + shq(v.ssid) + ' ' + v.bssid + ' ' + shq(CAPABILITIES[v.security]) + ' ' + v.freq + ' ' + v.signalDbm
        );
    }
    await wifiCmd(serial, 'start-faking-scans');
    await wifiCmd(serial, 'start-scan', { allowFailure: true });

    const state = {
        faking: true,
        networks: items.map((v) => ({ ssid: v.ssid, security: v.security, signalDbm: v.signalDbm, freq: v.freq, bssid: v.bssid })),
    };
    fakeScanStates.set(serial, state);
    return state;
}

async function stopFakeScan(serial) {
    log.info({ serial }, 'Stopping fake Wi-Fi scan');
    await wifiCmd(serial, 'stop-faking-scans', { allowFailure: true });
    await wifiCmd(serial, 'reset-fake-scans', { allowFailure: true });
    await wifiCmd(serial, 'start-scan', { allowFailure: true });
    const state = { faking: false, networks: [] };
    fakeScanStates.set(serial, state);
    return state;
}

function getFakeScanState(serial) {
    return fakeScanStates.get(serial) || { faking: false, networks: [] };
}

module.exports = { applyFakeScan, stopFakeScan, getFakeScanState, SECURITIES };
