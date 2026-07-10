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
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// Two independent fake-scan SOURCES per serial; the device shows their UNION:
//   manual   — user-defined networks (Network popup: applyFakeScan / stopFakeScan)
//   location — BSSID-sync from the GPS location (wifi-geo: setLocationFakeScan / clear)
// This lets "Sync Wi-Fi with location" coexist with the manual fake scan instead of
// fighting over the single start-faking-scans channel. getFakeScanState() reports the
// MANUAL view only, so the existing Network UI is unaffected by the location source.
const fakeScanSources = new Map(); // serial -> { manual: [items], location: [items] }

function getSources(serial) {
    let s = fakeScanSources.get(serial);
    if (!s) { s = { manual: [], location: [] }; fakeScanSources.set(serial, s); }
    return s;
}

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
    // BSSID: use the user's if a valid MAC is given, otherwise auto-generate.
    let bssid = String(net && net.bssid != null ? net.bssid : '').trim();
    if (bssid) {
        if (!MAC_RE.test(bssid)) {
            throw new Error('network[' + index + ']: bssid must be a MAC address like 02:00:00:00:00:01');
        }
        bssid = bssid.toLowerCase();
    } else {
        bssid = bssidFor(index);
    }
    return { ssid, security, signalDbm: dbm, freq, bssid };
}

// Run a `su 0 cmd wifi ...` command via adb (single argv; no local shell).
function wifiCmd(serial, deviceCommand, opts) {
    return runAdb(serial, ['shell', 'su 0 cmd wifi ' + deviceCommand], opts);
}

// Apply the UNION of both sources (dedup by BSSID; manual wins on a clash). An empty
// union stops faking so the real scan returns. One start-faking-scans owns the channel.
async function reapply(serial) {
    const s = getSources(serial);
    const seen = new Set();
    const items = [];
    for (const v of s.manual.concat(s.location)) {
        if (seen.has(v.bssid)) continue;
        seen.add(v.bssid);
        items.push(v);
    }

    if (items.length === 0) {
        log.info({ serial }, 'Stopping fake Wi-Fi scan (no sources)');
        await wifiCmd(serial, 'stop-faking-scans', { allowFailure: true });
        await wifiCmd(serial, 'reset-fake-scans', { allowFailure: true });
        await wifiCmd(serial, 'start-scan', { allowFailure: true });
        return;
    }

    log.info({ serial, total: items.length, manual: s.manual.length, location: s.location.length }, 'Applying fake Wi-Fi scan (merged)');
    await wifiCmd(serial, 'reset-fake-scans', { allowFailure: true });
    for (const v of items) {
        await wifiCmd(
            serial,
            'add-fake-scan ' + shq(v.ssid) + ' ' + v.bssid + ' ' + shq(CAPABILITIES[v.security]) + ' ' + v.freq + ' ' + v.signalDbm
        );
    }
    await wifiCmd(serial, 'start-faking-scans');
    await wifiCmd(serial, 'start-scan', { allowFailure: true });
}

function viewOf(items) {
    return items.map((v) => ({ ssid: v.ssid, security: v.security, signalDbm: v.signalDbm, freq: v.freq, bssid: v.bssid }));
}

// ----- Manual source (unchanged external contract for the Network UI) -----

async function applyFakeScan(serial, networks) {
    if (!Array.isArray(networks) || networks.length === 0) {
        throw new Error('networks must be a non-empty array');
    }
    getSources(serial).manual = networks.map((n, i) => validateNetwork(n, i));
    await reapply(serial);
    return getFakeScanState(serial);
}

async function stopFakeScan(serial) {
    getSources(serial).manual = [];
    await reapply(serial); // keeps faking if the location source is still active
    return getFakeScanState(serial);
}

// Manual-only view, so the Network UI's `faking`/`networks` reflect just its own
// source and are unaffected by BSSID-sync running in the location source.
function getFakeScanState(serial) {
    const s = getSources(serial);
    return { faking: s.manual.length > 0, networks: viewOf(s.manual) };
}

// ----- Location source (BSSID-sync from wifi-geo) -----

async function setLocationFakeScan(serial, networks) {
    getSources(serial).location = (Array.isArray(networks) ? networks : []).map((n, i) => validateNetwork(n, i));
    await reapply(serial);
    return { faking: getSources(serial).location.length > 0, count: getSources(serial).location.length };
}

async function clearLocationFakeScan(serial) {
    getSources(serial).location = [];
    await reapply(serial); // keeps faking if the manual source is still active
    return { faking: false, count: 0 };
}

module.exports = {
    applyFakeScan,
    stopFakeScan,
    getFakeScanState,
    setLocationFakeScan,
    clearLocationFakeScan,
    SECURITIES,
};
