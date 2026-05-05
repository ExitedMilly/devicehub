'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { GRPC_PORT } = require('./config');

const PROTO_PATH = path.join(__dirname, 'emulator_controller.proto');
let emulatorProto = null;
try {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
    });
    const proto = grpc.loadPackageDefinition(packageDefinition);
    emulatorProto = proto.android.emulation.control;
    console.log('[grpc] Loaded emulator_controller.proto');
} catch (err) {
    console.error('[grpc] Failed to load proto: ' + err.message);
    console.error('[grpc] Microphone input via gRPC will not be available');
}

function getGrpcAddressFromSerial(serial) {
    const hostname = serial.split(':')[0];
    return hostname + ':' + GRPC_PORT;
}

function callUnaryGrpc(client, method, payload) {
    return new Promise((resolve, reject) => {
        client[method](payload, (err, res) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(res);
        });
    });
}

module.exports = { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc };
