'use strict';

const { consoleExec } = require('../console-client');
const { runAdb } = require('../adb-runner');
const { networkStates } = require('../stores');
const log = require('../log').getLogger('domain/network');

const NETWORK_TYPES = ['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo', 'full'];
const REGISTRATION_STATES = ['unregistered', 'home', 'roaming', 'searching', 'denied'];

// Perceived signal bars (level 0..4) -> RSSI for `gsm signal <rssi> 0`.
// On modem_simulator `gsm signal-profile` snaps back to max, but `gsm signal`
// holds, so we drive the bars via RSSI. Values tunable to taste.
const RSSI_BY_LEVEL = [0, 6, 12, 18, 28];

// ----- Validators -----

function validateInt(value, min, max, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
    }
    return n;
}

function validateNetworkType(type) {
    if (!NETWORK_TYPES.includes(type)) {
        throw new Error('networkType must be one of: ' + NETWORK_TYPES.join(', '));
    }
    return type;
}

function validateRegistration(state) {
    if (!REGISTRATION_STATES.includes(state)) {
        throw new Error('registration must be one of: ' + REGISTRATION_STATES.join(', '));
    }
    return state;
}

// ----- Primitives -----
// Cellular (signal / type / roaming) goes through the emulator telnet console.
// Wi-Fi and airplane mode go through adb shell (networked adb works there).

function setSignalProfile(serial, p) {
    const v = validateInt(p, 0, 4, 'signalProfile');
    const lvl = Math.max(0, Math.min(4, v));
    return consoleExec(serial, ['gsm signal ' + RSSI_BY_LEVEL[lvl] + ' 0']);
}

function setSignal(serial, rssi, ber) {
    const r = validateInt(rssi, 0, 31, 'rssi');
    const b = validateInt(ber, 0, 7, 'ber');
    return consoleExec(serial, ['gsm signal ' + r + ' ' + b]);
}

function setNetworkType(serial, type) {
    const t = validateNetworkType(type);
    return consoleExec(serial, ['network speed ' + t]);
}

function setRegistration(serial, state) {
    const s = validateRegistration(state);
    return consoleExec(serial, ['gsm voice ' + s, 'gsm data ' + s]);
}

function setWifi(serial, on) {
    return runAdb(serial, ['shell', 'svc', 'wifi', on ? 'enable' : 'disable']);
}

function setAirplane(serial, on) {
    return runAdb(serial, ['shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable']);
}

async function getNetworkStatus(serial) {
    const [gsm] = (await consoleExec(serial, ['gsm status', 'network status'])).outputs;
    const gsmText = gsm || '';
    const voiceMatch = gsmText.match(/gsm voice state:\s*(\S+)/);
    const dataMatch = gsmText.match(/gsm data state:\s*(\S+)/);
    const voice = voiceMatch ? voiceMatch[1] : null;
    const data = dataMatch ? dataMatch[1] : null;

    const w = (await runAdb(serial, ['shell', 'cmd', 'wifi', 'status'])).stdout;
    const wifi = /Wifi is enabled/i.test(w);

    const a = (await runAdb(serial, ['shell', 'settings', 'get', 'global', 'airplane_mode_on'])).stdout.trim();
    const airplane = a === '1';

    const state = { voice, data, wifi, airplane };
    networkStates.set(serial, state);
    return state;
}

async function applyNetwork(serial, { signalProfile, rssi, ber, networkType, registration, wifi, airplane } = {}) {
    log.info({ serial, signalProfile, rssi, ber, networkType, registration, wifi, airplane }, 'Applying network state');

    if (signalProfile !== undefined && signalProfile !== null) {
        await setSignalProfile(serial, signalProfile);
    }
    if ((rssi !== undefined && rssi !== null) || (ber !== undefined && ber !== null)) {
        await setSignal(serial, rssi, ber);
    }
    if (networkType !== undefined && networkType !== null) {
        await setNetworkType(serial, networkType);
    }
    if (registration !== undefined && registration !== null) {
        await setRegistration(serial, registration);
    }
    if (wifi !== undefined && wifi !== null) {
        await setWifi(serial, wifi);
    }
    if (airplane !== undefined && airplane !== null) {
        await setAirplane(serial, airplane);
    }

    return getNetworkStatus(serial);
}

module.exports = {
    applyNetwork,
    setSignalProfile,
    setSignal,
    setNetworkType,
    setRegistration,
    setWifi,
    setAirplane,
    getNetworkStatus,
};
