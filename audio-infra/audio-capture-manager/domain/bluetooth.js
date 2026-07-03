'use strict';

// Runtime Bluetooth adapter control for the emulator. Toggled live via adb,
// no restart:
//   on:   su 0 cmd bluetooth_manager enable
//   off:  su 0 cmd bluetooth_manager disable
//   read: dumpsys bluetooth_manager   (adapter "state: ON/OFF")
// `su 0` (root) is needed to flip the adapter; args reach adb as separate argv
// elements (no local shell), same as proxy/wifi-autoconnect. The read is a
// plain dumpsys (no root needed).

const { runAdb } = require('../adb-runner');
const log = require('../log').getLogger('domain/bluetooth');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse `dumpsys bluetooth_manager` -> { enabled, state }.
// The adapter's canonical field is the first `state: <TOKEN>` line
// (ON / OFF / TURNING_ON / TURNING_OFF / BLE_ON ...).
function parseBtState(stdout) {
    const text = String(stdout || '');
    const m = text.match(/state:\s*([A-Za-z_]+)/i);
    const state = m ? m[1].toUpperCase() : null;
    return { enabled: state === 'ON', state };
}

async function getBtState(serial) {
    const result = await runAdb(serial, ['shell', 'dumpsys', 'bluetooth_manager']);
    return parseBtState(result.stdout);
}

async function setBt(serial, enabled) {
    const action = enabled ? 'enable' : 'disable';
    log.info({ serial, action }, 'Setting Bluetooth adapter');
    await runAdb(serial, ['shell', 'su', '0', 'cmd', 'bluetooth_manager', action]);

    // The adapter transitions (TURNING_ON -> ON); poll briefly so the response
    // reflects the settled state rather than a transient one.
    const want = enabled ? 'ON' : 'OFF';
    let state = await getBtState(serial);
    for (let i = 0; i < 6 && state.state !== want; i++) {
        await delay(700);
        state = await getBtState(serial);
    }
    return state;
}

module.exports = { getBtState, setBt, parseBtState };
