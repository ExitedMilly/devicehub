'use strict';

const grpc = require('@grpc/grpc-js');
const { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc } = require('../grpc-client');
const { poseStates } = require('../stores');
const log = require('../log').getLogger('domain/pose');

function validatePoseAngles(pitch, yaw, roll) {
    const p = Number(pitch);
    const y = Number(yaw);
    const r = Number(roll);

    if (!Number.isFinite(p)) {
        throw new Error('pitch must be a valid number');
    }
    if (!Number.isFinite(y)) {
        throw new Error('yaw must be a valid number');
    }
    if (!Number.isFinite(r)) {
        throw new Error('roll must be a valid number');
    }

    if (p < -180 || p > 180) {
        throw new Error('pitch must be between -180 and 180');
    }
    if (y < -180 || y > 180) {
        throw new Error('yaw must be between -180 and 180');
    }
    if (r < -180 || r > 180) {
        throw new Error('roll must be between -180 and 180');
    }

    return { pitch: p, yaw: y, roll: r };
}

function getPoseStatesStatus() {
    const result = {};
    for (const [serial, pose] of poseStates) {
        result[serial] = pose;
    }
    return result;
}

async function setDevicePoseRotation(serial, pitch, yaw, roll) {
    if (!emulatorProto) {
        throw new Error('gRPC proto not loaded');
    }

    const normalized = validatePoseAngles(pitch, yaw, roll);
    const grpcAddress = getGrpcAddressFromSerial(serial);

    log.info({ serial, pitch: normalized.pitch, yaw: normalized.yaw, roll: normalized.roll, grpcAddress }, 'Applying rotation');

    const grpcClient = new emulatorProto.EmulatorController(
        grpcAddress,
        grpc.credentials.createInsecure()
    );

    await callUnaryGrpc(grpcClient, 'setPhysicalModel', {
        target: 'ROTATION',
        value: {
            data: [normalized.pitch, normalized.yaw, normalized.roll],
        },
    });

    // Small delay so readback is more reliable
    await new Promise((resolve) => setTimeout(resolve, 500));

    const rotationState = await callUnaryGrpc(grpcClient, 'getPhysicalModel', {
        target: 'ROTATION',
    });

    const accelerationState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'ACCELERATION',
    });

    const orientationState = await callUnaryGrpc(grpcClient, 'getSensor', {
        target: 'ORIENTATION',
    });

    const result = {
        serial,
        pitch: normalized.pitch,
        yaw: normalized.yaw,
        roll: normalized.roll,
        appliedAt: new Date().toISOString(),
        rotation: rotationState && rotationState.value ? rotationState.value.data : null,
        acceleration: accelerationState && accelerationState.value ? accelerationState.value.data : null,
        orientation: orientationState && orientationState.value ? orientationState.value.data : null,
    };

    poseStates.set(serial, result);

    return result;
}

module.exports = {
    validatePoseAngles,
    getPoseStatesStatus,
    setDevicePoseRotation,
};
