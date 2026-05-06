'use strict';

const grpc = require('@grpc/grpc-js');
const { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc } = require('../grpc-client');
const { runAdb } = require('../adb-runner');
const { lightStates } = require('../stores');

function validateLightLux(lux) {
    const value = Number(lux);

    if (!Number.isFinite(value)) {
        throw new Error('lux must be a valid number');
    }
    if (value < 0) {
        throw new Error('lux must be greater than or equal to 0');
    }

    return value;
}

function getLightStatesStatus() {
    const result = {};
    for (const [serial, light] of lightStates) {
        result[serial] = light;
    }
    return result;
}

function extractGrpcNumericValue(response) {
    if (!response || !response.value || !Array.isArray(response.value.data) || response.value.data.length === 0) {
        return null;
    }

    const value = Number(response.value.data[0]);
    return Number.isFinite(value) ? value : null;
}

function parseAdbLightGetOutput(stdout) {
    const match = String(stdout || '').match(/light\s*=\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) return null;

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

async function getAdbLightValue(serial) {
    const result = await runAdb(serial, ['emu', 'sensor', 'get', 'light']);
    return parseAdbLightGetOutput(result.stdout);
}

async function setDeviceLightViaAdb(serial, lux) {
    const normalizedLux = validateLightLux(lux);

    await runAdb(serial, ['emu', 'sensor', 'set', 'light', String(normalizedLux)]);
    const sensorLux = await getAdbLightValue(serial);

    return {
        appliedVia: 'adbConsole',
        physicalLux: null,
        sensorLux: sensorLux,
    };
}

async function setDeviceLightViaGrpcPhysicalModel(serial, lux) {
    if (!emulatorProto) {
        throw new Error('gRPC proto not loaded');
    }

    const normalizedLux = validateLightLux(lux);
    const grpcAddress = getGrpcAddressFromSerial(serial);

    const grpcClient = new emulatorProto.EmulatorController(
        grpcAddress,
        grpc.credentials.createInsecure()
    );

    await callUnaryGrpc(grpcClient, 'setPhysicalModel', {
        target: 'LIGHT',
        value: {
            data: [normalizedLux],
        },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const physicalState = await callUnaryGrpc(grpcClient, 'getPhysicalModel', {
        target: 'LIGHT',
    });

    const sensorState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'LIGHT',
    });

    return {
        appliedVia: 'physicalModel',
        physicalLux: extractGrpcNumericValue(physicalState),
        sensorLux: extractGrpcNumericValue(sensorState),
    };
}

async function setDeviceLight(serial, lux) {
    const normalizedLux = validateLightLux(lux);

    console.log('[light] Applying ambient light to ' + serial + ': lux=' + normalizedLux);

    let appliedVia = null;
    let physicalLux = null;
    let sensorLux = null;
    let fallbackReason = null;

    try {
        const grpcResult = await setDeviceLightViaGrpcPhysicalModel(serial, normalizedLux);
        appliedVia = grpcResult.appliedVia;
        physicalLux = grpcResult.physicalLux;
        sensorLux = grpcResult.sensorLux;

        const hasAcceptableReadback = [physicalLux, sensorLux].some((value) =>
            value !== null && Math.abs(value - normalizedLux) <= 0.01
        );

        if (!hasAcceptableReadback) {
            throw new Error(
                'gRPC light readback mismatch: physical=' +
                String(physicalLux) + ', sensor=' + String(sensorLux)
            );
        }
    } catch (err) {
        fallbackReason = err.message;
        console.warn('[light] gRPC path failed for ' + serial + ', falling back to adb emu: ' + err.message);

        const adbResult = await setDeviceLightViaAdb(serial, normalizedLux);
        appliedVia = adbResult.appliedVia;
        physicalLux = adbResult.physicalLux;
        sensorLux = adbResult.sensorLux;
    }

    const result = {
        serial: serial,
        lux: normalizedLux,
        appliedAt: new Date().toISOString(),
        appliedVia: appliedVia,
        physicalLux: physicalLux,
        sensorLux: sensorLux,
        fallbackReason: fallbackReason,
    };

    lightStates.set(serial, result);
    return result;
}

module.exports = {
    validateLightLux,
    getLightStatesStatus,
    extractGrpcNumericValue,
    parseAdbLightGetOutput,
    getAdbLightValue,
    setDeviceLightViaAdb,
    setDeviceLightViaGrpcPhysicalModel,
    setDeviceLight,
};
