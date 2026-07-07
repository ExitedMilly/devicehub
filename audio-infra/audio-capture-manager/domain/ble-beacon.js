'use strict';

// Read-only view of the fake BLE beacons currently in the instance's netsim.
// netsim's frontend HTTP API (GET /v1/devices) listens on 127.0.0.1 INSIDE the
// emulator container, which the manager (a separate container) cannot reach
// directly. But netsim's Wi-Fi slirp maps the guest's 10.0.2.2 to the container
// loopback, so we read the API from inside the Android guest over adb, using
// toybox `nc` as a tiny HTTP client. This requires the guest to be connected to
// the netsim Wi-Fi AP (10.0.2.x); if it is not, netsim's frontend is unreachable
// and we surface that clearly. Read-only: no create/delete.

const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/ble-beacon');

const NETSIM_HOST = '10.0.2.2';   // netsim Wi-Fi slirp alias -> container loopback
const NETSIM_PORT = 7681;         // netsimd web.port (stable default)

function b64ToHex(b64) {
    try {
        return Buffer.from(String(b64 || ''), 'base64').toString('hex');
    } catch {
        return '';
    }
}

// Extract the JSON body from a raw HTTP/1.1 response (headers + body).
function parseHttpJson(raw) {
    const text = String(raw || '');
    const start = text.indexOf('{');
    if (start < 0) {
        throw new Error('netsim frontend unreachable — is the device connected to the netsim Wi-Fi?');
    }
    return JSON.parse(text.slice(start));
}

function beaconFromChip(deviceName, chip) {
    const b = (chip && chip.bleBeacon) || {};
    const settings = b.settings || {};
    const adv = b.advData || {};
    const services = Array.isArray(adv.services) ? adv.services : [];
    return {
        name: deviceName || null,
        address: b.address || null,
        scannable: !!settings.scannable,
        includeDeviceName: !!adv.includeDeviceName,
        advertiseMode: settings.advertiseMode || null,
        intervalMs: settings.milliseconds != null ? Number(settings.milliseconds) : null,
        txPowerLevel: settings.txPowerLevel || null,
        dbm: settings.dbm != null ? Number(settings.dbm) : null,
        manufacturerData: adv.manufacturerData ? b64ToHex(adv.manufacturerData) : null,
        services: services.map((s) => ({ uuid: s.uuid || null, data: s.data ? b64ToHex(s.data) : null })),
    };
}

async function listBeacons(serial) {
    // Ask the guest to GET /v1/devices from netsim via nc (a tiny HTTP client).
    // Single argv element to adb; the device shell interprets the pipe/printf.
    const httpReq = "printf 'GET /v1/devices HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n' | toybox nc -w 5 " + NETSIM_HOST + ' ' + NETSIM_PORT;
    const result = await runAdb(serial, ['shell', httpReq], { timeoutMs: 12000 });
    const raw = result.stdout || '';
    if (!raw.trim()) {
        throw new Error('netsim frontend unreachable — is the device connected to the netsim Wi-Fi?');
    }

    const data = parseHttpJson(raw);
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const beacons = [];
    for (const device of devices) {
        for (const chip of (device.chips || [])) {
            if (chip && chip.kind === 'BLUETOOTH_BEACON') {
                beacons.push(beaconFromChip(device.name, chip));
            }
        }
    }
    log.info({ serial, count: beacons.length }, 'Listed BLE beacons');
    return beacons;
}

module.exports = { listBeacons, parseHttpJson };
