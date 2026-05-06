'use strict';

const walkSimulator = require('./domain/walk-simulator');
const poseScenario = require('./domain/pose-scenario');
const backupLogical = require('./domain/backup-logical');

const config = require('./config');
const {
    MANAGER_PORT, PA_SERVER, MIC_PIPE_DIR,
    MIC_STATE_POLL_MS, CAMERA_V4L2_DEVICE,
    GPS_KEEPALIVE_INTERVAL_MS, PA_POLL_INTERVAL_MS, AUTO_DISCOVER, EMULATOR_MAP_RAW,
} = config;
const { instances, micRtcInstances, cameraInstances, gpsSessions } = require('./stores');
const { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc } = require('./grpc-client');
const { paMonitor } = require('./pulse-monitor');
const { micStateMonitor } = require('./mic/state-monitor');
const { cameraStateMonitor } = require('./camera/state-monitor');
const { stopCameraWriter, startGlobalBlackFeed } = require('./camera/writer');
const {
    setMockGpsLocation, stopGpsKeepAlive, startGpsKeepAlive,
} = require('./domain/gps');
const { setDevicePoseRotation } = require('./domain/pose');

const { server } = require('./http/server');
const { attachWsServer } = require('./ws/server');

walkSimulator.init({
    setMockGpsLocation,
    startGpsKeepAlive,
    stopGpsKeepAlive,
});

poseScenario.init({
    emulatorProto: emulatorProto,
    callUnaryGrpc: callUnaryGrpc,
    getGrpcAddressFromSerial: getGrpcAddressFromSerial,
    setDevicePoseRotation: setDevicePoseRotation,
});

attachWsServer(server);

// ===================== Startup =====================

server.listen(MANAGER_PORT, '0.0.0.0', () => {
    console.log('[audio-capture-manager] Listening on port ' + MANAGER_PORT);
    console.log('[audio-capture-manager] PA_SERVER=' + PA_SERVER);
    console.log('[audio-capture-manager] AUTO_DISCOVER=' + AUTO_DISCOVER);
    console.log('[audio-capture-manager] PA_POLL_INTERVAL=' + PA_POLL_INTERVAL_MS + 'ms');
    console.log('[audio-capture-manager] MIC_STATE_POLL=' + MIC_STATE_POLL_MS + 'ms');
    if (EMULATOR_MAP_RAW) {
        console.log('[audio-capture-manager] EMULATOR_MAP=' + EMULATOR_MAP_RAW);
    }
    console.log('[audio-capture-manager] HTTP API: http://0.0.0.0:' + MANAGER_PORT + '/api/');
    console.log('[audio-capture-manager] Audio WS:  ws://0.0.0.0:' + MANAGER_PORT + '/audio/{serial}');
    console.log('[audio-capture-manager] Mic RTC WS: ws://0.0.0.0:' + MANAGER_PORT + '/mic-rtc/{serial}');
    console.log('[audio-capture-manager] Mic State:  ws://0.0.0.0:' + MANAGER_PORT + '/mic-state/{serial}');
    console.log('[audio-capture-manager] Camera WS:  ws://0.0.0.0:' + MANAGER_PORT + '/camera/{serial}');
    console.log('[audio-capture-manager] Camera State: ws://0.0.0.0:' + MANAGER_PORT + '/camera-state/{serial}');
    console.log('[audio-capture-manager] MIC_PIPE_DIR=' + MIC_PIPE_DIR);
    console.log('[audio-capture-manager] CAMERA_V4L2_DEVICE=' + CAMERA_V4L2_DEVICE);
    console.log('[audio-capture-manager] GPS API: http://0.0.0.0:' + MANAGER_PORT + '/api/gps/{serial}');
    console.log('[audio-capture-manager] GPS keepalive interval=' + GPS_KEEPALIVE_INTERVAL_MS + 'ms');
    console.log('[audio-capture-manager] Pose API: http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}');
    console.log('[audio-capture-manager] Light API: http://0.0.0.0:' + MANAGER_PORT + '/api/light/{serial}');
    console.log('[audio-capture-manager] Walk API: http://0.0.0.0:' + MANAGER_PORT + '/api/walk/{serial}/(start|pause|resume|stop|status)');
    console.log('[audio-capture-manager] Pose Scenario API: http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}/scenario/(start|pause|resume|stop|status)');
    console.log('[audio-capture-manager] Pose Scenario tick=' + poseScenario.TICK_HZ + ' Hz');
    console.log('[audio-capture-manager] Backup API: http://0.0.0.0:' + MANAGER_PORT + '/api/backup/{serial} (POST create, GET /status) — dir: ' + backupLogical.BACKUP_DIR);
    console.log('[audio-capture-manager] Backup: logical (APK + /sdcard/), dir=' + (process.env.BACKUP_DIR || '/backups') + ' — POST /api/backup/{serial}, POST /api/backup/{serial}/restore, GET /api/backup/{serial}/status');
    // Start PA auto-discovery
    paMonitor.start();
    // Start mic state monitoring
    micStateMonitor.start();
    // Start camera state monitoring
    cameraStateMonitor.start();

    // Start black feed on v4l2loopback to keep camera alive for emulators
    startGlobalBlackFeed();
});

process.on('SIGTERM', () => {
    paMonitor.stop();
    micStateMonitor.stop();
    cameraStateMonitor.stop();
    stopCameraWriter();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micRtcInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    for (const serial of Array.from(gpsSessions.keys())) {
        stopGpsKeepAlive(serial);
    }
    walkSimulator.shutdown();
    poseScenario.shutdown();
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    paMonitor.stop();
    micStateMonitor.stop();
    cameraStateMonitor.stop();
    stopCameraWriter();
    for (const [, inst] of instances) inst.stop();
    for (const [, inst] of micRtcInstances) inst.stop();
    for (const [, inst] of cameraInstances) inst.stop();
    for (const serial of Array.from(gpsSessions.keys())) {
        stopGpsKeepAlive(serial);
    }
    walkSimulator.shutdown();
    poseScenario.shutdown();
    server.close(() => process.exit(0));
});
