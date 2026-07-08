'use strict';

// Ambient temperature operblock: set the device's ambient temperature sensor
// (°C) via the emulator console `sensor set temperature <value>` (one scalar).
//
// Channel: the same emulator console used by sensor-noise (consoleExec). This
// writes the SAME sensor layer as the gRPC physical model (last-write-wins), so
// coexistence with sensor-noise is handled by the scenario RESOURCE MODEL: while
// this operblock is active it owns the `temperature` resource and sensor-noise
// SKIPS the temperature sensor (see domain/sensor-noise.js RESOURCE_SENSORS).

const { consoleExec } = require('../console-client');
const log = require('../log').getLogger('domain/temperature');

const CONSOLE_TIMEOUT_MS = 6000;

// Generous physical guard rails; the UI constrains to a realistic sub-range.
const MIN_TEMP_C = -50;
const MAX_TEMP_C = 100;

function validateTemperature(celsius) {
    const value = Number(celsius);
    if (!Number.isFinite(value)) {
        throw new Error('celsius must be a valid number');
    }
    if (value < MIN_TEMP_C || value > MAX_TEMP_C) {
        throw new Error('celsius must be within [' + MIN_TEMP_C + ', ' + MAX_TEMP_C + ']');
    }
    return value;
}

function fmt(n) {
    return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

// Parse the first number out of a `sensor get temperature` response
// (e.g. "temperature = 10" -> 10).
function parseTemperatureGet(output) {
    const match = String(output || '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
}

async function setDeviceTemperature(serial, celsius) {
    const value = validateTemperature(celsius);
    log.info({ serial, celsius: value }, 'Applying ambient temperature');

    const res = await consoleExec(
        serial,
        ['sensor set temperature ' + fmt(value), 'sensor get temperature'],
        { timeoutMs: CONSOLE_TIMEOUT_MS }
    );

    const sensorTemp = parseTemperatureGet(res && res.outputs && res.outputs[1]);

    return {
        serial: serial,
        celsius: value,
        appliedAt: new Date().toISOString(),
        appliedVia: 'console',
        sensorTemp: sensorTemp,
    };
}

module.exports = {
    validateTemperature,
    parseTemperatureGet,
    setDeviceTemperature,
    MIN_TEMP_C,
    MAX_TEMP_C,
};
