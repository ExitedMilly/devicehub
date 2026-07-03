'use strict';

// Wi-Fi auto-connect: the emulator (op-v2 image) broadcasts a custom SSID via
// netsim (-netsim-args "--wifi <ssid> <pass>"), but the default profile baked
// into system.img targets "AndroidWifi", so the device never joins the renamed
// AP on its own. Once, after boot, we push a root wifi command to join it.
//
// Transport: the same adb path GPS/battery use — runAdb(serial, [...]) →
// `adb -s <serial> shell ...`. The device is rootable via `su 0 <cmd>` (no full
// `adb root` needed). Idempotent: re-adding an existing network is harmless.

const { execFile } = require('child_process');
const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/wifi-autoconnect');

const RETRY_INTERVAL_MS = 10000;
const MAX_ATTEMPTS = 12;
const ADB_CMD_TIMEOUT_MS = 8000;

// Idempotent `adb connect <target>` (no -s; connect has no per-device flag).
// Failures are non-fatal — the retry loop covers "emulator not up yet".
function adbConnect(target) {
    return new Promise((resolve) => {
        execFile('adb', ['connect', target], { timeout: 5000 }, () => resolve());
    });
}

// Security-mode args for `cmd wifi`: open network vs WPA2 with a password.
function securityArgs(password) {
    return password ? ['wpa2', password] : ['open'];
}

async function attempt(serial, ssid, password) {
    // Ensure adb is connected (harmless if mic-monitor already connected it).
    await adbConnect(serial);

    const sec = securityArgs(password);
    // `su 0 <cmd>` runs as root without a full `adb root`. Args are passed as
    // argv straight to adb (no local shell), so simple values are injection-safe.
    await runAdb(serial, ['shell', 'su', '0', 'cmd', 'wifi', 'add-network', ssid, ...sec],
        { allowFailure: true, timeoutMs: ADB_CMD_TIMEOUT_MS });
    await runAdb(serial, ['shell', 'su', '0', 'cmd', 'wifi', 'connect-network', ssid, ...sec],
        { allowFailure: true, timeoutMs: ADB_CMD_TIMEOUT_MS });

    // Success = wifi status reports us connected to our SSID.
    const status = await runAdb(serial, ['shell', 'su', '0', 'cmd', 'wifi', 'status'],
        { allowFailure: true, timeoutMs: ADB_CMD_TIMEOUT_MS });
    const out = (status && status.stdout) || '';
    return out.includes(ssid) && /connected/i.test(out);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop(serial, ssid, password) {
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        try {
            if (await attempt(serial, ssid, password)) {
                log.info({ serial, ssid, attempt: n }, 'wifi-autoconnect: connected');
                return;
            }
            log.info({ serial, ssid, attempt: n }, 'wifi-autoconnect: not connected yet (device may still be booting), retrying');
        } catch (err) {
            log.warn({ serial, ssid, attempt: n, err: err.message }, 'wifi-autoconnect: attempt failed, retrying');
        }
        if (n < MAX_ATTEMPTS) await sleep(RETRY_INTERVAL_MS);
    }
    log.warn({ serial, ssid, attempts: MAX_ATTEMPTS }, 'wifi-autoconnect: gave up (device never reported connected)');
}

// Fire-and-forget: kicks off a background retry loop. No-op when ssid is empty
// (stock AndroidWifi). Never blocks manager startup.
function start(serial, ssid, password) {
    if (!ssid) return; // no custom SSID -> keep stock behaviour
    log.info({ serial, ssid, secured: !!password }, 'wifi-autoconnect: connecting to ' + ssid);
    void loop(serial, ssid, password);
}

module.exports = { start };
