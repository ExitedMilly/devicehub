'use strict';

// Emulator phone number control — UI runtime path only.
//   The DEFAULT number (from instances.yaml) is now baked into the SIM profile by
//   the emulator op-shim (EF_MSISDN in iccprofile_for_sim0.xml), so it survives
//   radio-init and no longer needs a manager-side console loop.
//   This module keeps the runtime override used by the UI: `phonenumber <digits>`
//   over the telnet console (DIGITS ONLY — a leading + returns KO). The runtime
//   change is temporary (until the SIM is re-read / emulator restart).
//   Reading the current number: `su 0 service call iphonesubinfo 15 ...` (Parcel;
//   parsing is best-effort).

const { consoleExec } = require('../console-client');
const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/phonenumber');

function validateNumber(number) {
    const n = String(number == null ? '' : number).trim();
    if (!/^\d{7,15}$/.test(n)) {
        throw new Error('number must be 7-15 digits (no leading +)');
    }
    return n;
}

// Best-effort digits extraction from a `service call iphonesubinfo` Parcel dump.
// The number appears in the ASCII (single-quoted) columns as UTF-16 chars
// interleaved with dots/nulls; strip everything but digits.
function parseServiceCallNumber(stdout) {
    const text = String(stdout || '');
    const quoted = text.match(/'[^']*'/g);
    if (!quoted) return null;
    const digits = quoted.join('').replace(/[^0-9]/g, '');
    return digits.length >= 7 ? digits : null;
}

async function setNumber(serial, number) {
    const n = validateNumber(number);
    log.info({ serial, number: n }, 'Setting phone number (runtime override)');
    await consoleExec(serial, ['phonenumber ' + n]);
    return { number: n };
}

async function getNumber(serial) {
    try {
        const res = await runAdb(
            serial,
            ['shell', 'su', '0', 'service', 'call', 'iphonesubinfo', '15', 's16', 'com.android.shell'],
            { allowFailure: true }
        );
        return { number: parseServiceCallNumber(res.stdout), raw: (res.stdout || '').trim() };
    } catch (err) {
        return { number: null, raw: null };
    }
}

module.exports = { setNumber, getNumber, validateNumber, parseServiceCallNumber };
