'use strict';

// Runtime management of the fake BLE beacons in the instance's netsim: list /
// add / remove. netsim's frontend REST API binds 127.0.0.1:7681 INSIDE the
// emulator container; the op-v3 image runs a socat proxy that re-exposes it on
// 0.0.0.0:7682, reachable in the docker network as emulator-<instance>:7682. So
// the manager talks HTTP straight to that proxy (unlike the localhost-only 7681,
// this needs no adb/guest Wi-Fi). Requires the op-v3 emulator image.
//
// netsim API (verified on netsimd 0.3.105):
//   GET    /v1/devices                 -> { devices: [ { name, chips:[{kind,id,bleBeacon}] } ] }
//   POST   /v1/devices  {device:...}   -> create (duplicate MAC => 404)
//   DELETE /v1/devices  {id: <chipId>} -> delete the chip (its device goes too)
// Delete is by CHIP id, so we GET first to resolve name -> chips[].id.

const http = require('http');
const log = require('../log').getLogger('domain/ble-beacon');

const NETSIM_PROXY_PORT = 7682;

const TX_POWER_LEVELS = { 'ultra-low': 'ULTRA_LOW', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };
const ADVERTISE_MODES = { 'low-power': 'LOW_POWER', balanced: 'BALANCED', 'low-latency': 'LOW_LATENCY' };
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// The emulator container host is the part of the serial before ":port".
function emulatorHost(serial) {
    return String(serial || '').split(':')[0];
}

function b64ToHex(b64) {
    try {
        return Buffer.from(String(b64 || ''), 'base64').toString('hex');
    } catch {
        return '';
    }
}

function hexToB64(hex, field) {
    const h = String(hex).trim();
    if (h.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(h)) {
        throw new Error(field + ' must be an even-length hex string');
    }
    return Buffer.from(h, 'hex').toString('base64');
}

// Build a netsim CreateDeviceRequest (root "device") from a beacon spec, mapping
// friendly fields to the proto-JSON shape (hex->base64, enum names, MAC ->
// bleBeacon.address). Mirrors scripts/generate.py:beacon_to_payload.
function buildBeaconPayload(spec) {
    const name = String(spec && spec.name != null ? spec.name : '').trim();
    if (!name) {
        throw new Error('name is required');
    }

    const settings = { scannable: spec.scannable !== false, timeout: 0 };

    if (spec.interval != null && String(spec.interval) !== '') {
        const key = String(spec.interval).trim().toLowerCase();
        if (ADVERTISE_MODES[key]) {
            settings.advertiseMode = ADVERTISE_MODES[key];
        } else {
            const ms = Number(spec.interval);
            if (!Number.isInteger(ms) || ms <= 0) {
                throw new Error('interval must be low-power|balanced|low-latency or a positive integer (ms)');
            }
            settings.milliseconds = ms;
        }
    } else {
        settings.advertiseMode = 'LOW_LATENCY';
    }

    if (spec.tx_power != null && String(spec.tx_power) !== '') {
        const key = String(spec.tx_power).trim().toLowerCase();
        if (TX_POWER_LEVELS[key]) {
            settings.txPowerLevel = TX_POWER_LEVELS[key];
        } else {
            const dbm = Number(spec.tx_power);
            if (!Number.isInteger(dbm) || dbm < -127 || dbm > 127) {
                throw new Error('tx_power must be ultra-low|low|medium|high or an integer dBm between -127 and 127');
            }
            settings.dbm = dbm;
        }
    }

    const advData = { includeDeviceName: spec.include_device_name !== false };
    if (spec.manufacturer_data) {
        advData.manufacturerData = hexToB64(spec.manufacturer_data, 'manufacturer_data');
    }
    if (spec.service_uuid) {
        const service = { uuid: String(spec.service_uuid) };
        if (spec.service_data) {
            service.data = hexToB64(spec.service_data, 'service_data');
        }
        advData.services = [service];
    } else if (spec.service_data) {
        throw new Error('service_data requires service_uuid');
    }

    const bleBeacon = { settings, advData };
    if (spec.mac) {
        const mac = String(spec.mac).trim();
        if (!MAC_RE.test(mac)) {
            throw new Error('mac must be a MAC address like 02:00:00:00:00:01');
        }
        bleBeacon.address = mac.toLowerCase();
    }

    return { device: { name, chips: [{ kind: 'BLUETOOTH_BEACON', bleBeacon }] } };
}

// One HTTP request to the emulator's netsim proxy. Resolves { status, body }.
function netsimRequest(host, method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                host,
                port: NETSIM_PROXY_PORT,
                path,
                method,
                timeout: 8000,
                headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
            },
            (res) => {
                let b = '';
                res.on('data', (c) => { b += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: b }));
            }
        );
        req.on('error', (err) => {
            reject(new Error('netsim proxy unreachable at ' + host + ':' + NETSIM_PROXY_PORT + ' (needs the op-v3 image): ' + err.message));
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('netsim proxy timed out at ' + host + ':' + NETSIM_PROXY_PORT));
        });
        if (data) req.write(data);
        req.end();
    });
}

function beaconFromChip(deviceName, chip) {
    const b = (chip && chip.bleBeacon) || {};
    const settings = b.settings || {};
    const adv = b.advData || {};
    const services = Array.isArray(adv.services) ? adv.services : [];
    return {
        id: chip.id != null ? Number(chip.id) : null,   // chip id — used to remove
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

async function fetchBeacons(host) {
    const res = await netsimRequest(host, 'GET', '/v1/devices');
    const start = res.body.indexOf('{');
    if (start < 0) {
        throw new Error('netsim returned no device list');
    }
    const data = JSON.parse(res.body.slice(start));
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const beacons = [];
    for (const device of devices) {
        for (const chip of (device.chips || [])) {
            if (chip && chip.kind === 'BLUETOOTH_BEACON') {
                beacons.push(beaconFromChip(device.name, chip));
            }
        }
    }
    return beacons;
}

async function listBeacons(serial) {
    const beacons = await fetchBeacons(emulatorHost(serial));
    log.info({ serial, count: beacons.length }, 'Listed BLE beacons');
    return beacons;
}

async function addBeacon(serial, spec) {
    const host = emulatorHost(serial);
    const payload = buildBeaconPayload(spec);
    log.info({ serial, name: payload.device.name }, 'Adding BLE beacon');
    const res = await netsimRequest(host, 'POST', '/v1/devices', payload);
    if (res.status === 404) {
        throw new Error('could not create beacon (a beacon with this MAC may already exist)');
    }
    if (res.status < 200 || res.status >= 300) {
        throw new Error('netsim rejected the beacon (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
    }
    return listBeacons(serial);
}

async function removeBeacon(serial, identifier) {
    const host = emulatorHost(serial);
    let chipId;
    if (/^\d+$/.test(String(identifier))) {
        chipId = Number(identifier);
    } else {
        // Resolve a device name to its BLE-beacon chip id.
        const beacons = await fetchBeacons(host);
        const match = beacons.find((b) => b.name === String(identifier));
        if (!match || match.id == null) {
            throw new Error('no beacon found named "' + identifier + '"');
        }
        chipId = match.id;
    }
    log.info({ serial, chipId }, 'Removing BLE beacon');
    const res = await netsimRequest(host, 'DELETE', '/v1/devices', { id: chipId });
    if (res.status < 200 || res.status >= 300) {
        throw new Error('netsim could not remove beacon chip ' + chipId + ' (HTTP ' + res.status + '): ' + res.body.slice(0, 120));
    }
    return listBeacons(serial);
}

module.exports = { listBeacons, addBeacon, removeBeacon, buildBeaconPayload };
