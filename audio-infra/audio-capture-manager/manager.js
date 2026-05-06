const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { server } = require('./http/server');

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
const { registry } = require('./emulator-registry');
const { paMonitor } = require('./pulse-monitor');
const { micStateMonitor } = require('./mic/state-monitor');
const { cameraStateMonitor } = require('./camera/state-monitor');
const { stopCameraWriter, startGlobalBlackFeed } = require('./camera/writer');
const { WebRTCMicrophoneInstance } = require('./mic/webrtc');
const { CameraInstance } = require('./camera/instance');
const {
    setMockGpsLocation, stopGpsKeepAlive, startGpsKeepAlive,
} = require('./domain/gps');
const { setDevicePoseRotation } = require('./domain/pose');

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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);

    // Audio output: emulator → browser
    const audioMatch = url.pathname.match(/^\/audio\/(.+)$/);
    if (audioMatch) {
        const serial = decodeURIComponent(audioMatch[1]);
        const instance = instances.get(serial);
        if (!instance) { ws.close(4004, 'No capture for ' + serial); return; }
        if (instance.state !== 'running') { ws.close(4003, 'Not ready: ' + instance.state); return; }
        instance.addClient(ws);
        return;
    }

    // Mic input via WebRTC: browser → emulator
    const micRtcMatch = url.pathname.match(/^\/mic-rtc\/(.+)$/);
    if (micRtcMatch) {
        const serial = decodeURIComponent(micRtcMatch[1]);

        let sinkIndex = null;
        const captureInstance = instances.get(serial);
        if (captureInstance) {
            sinkIndex = captureInstance.sinkIndex;
        } else {
            const hostname = serial.split(':')[0];
            const info = registry.resolve(hostname);
            sinkIndex = info.sinkIndex;
        }

        let micRtcInst = micRtcInstances.get(serial);
        if (!micRtcInst || micRtcInst.state === 'stopped') {
            micRtcInst = new WebRTCMicrophoneInstance(serial, sinkIndex);
            micRtcInstances.set(serial, micRtcInst);
        }

        if (micRtcInst.client) {
            ws.close(4009, 'Mic RTC already in use for ' + serial);
            return;
        }

        micRtcInst.start(ws);
        return;
    }

    // Mic state subscription: browser subscribes to emulator mic state changes
    const micStateMatch = url.pathname.match(/^\/mic-state\/(.+)$/);
    if (micStateMatch) {
        const serial = decodeURIComponent(micStateMatch[1]);
        console.log('[mic-state] Subscriber connected for ' + serial);
        micStateMonitor.subscribe(serial, ws);

        ws.on('close', () => {
            console.log('[mic-state] Subscriber disconnected for ' + serial);
        });
        return;
    }

    // Camera input: browser → emulator (video via v4l2loopback)
    const cameraMatch = url.pathname.match(/^\/camera\/(.+)$/);
    if (cameraMatch) {
        const serial = decodeURIComponent(cameraMatch[1]);

        // Resolve sinkIndex
        let sinkIndex = null;
        const captureInstance = instances.get(serial);
        if (captureInstance) {
            sinkIndex = captureInstance.sinkIndex;
        } else {
            const hostname = serial.split(':')[0];
            const info = registry.resolve(hostname);
            sinkIndex = info.sinkIndex;
        }

        // Get or create CameraInstance
        let camInst = cameraInstances.get(serial);
        if (!camInst || camInst.state === 'stopped') {
            camInst = new CameraInstance(serial, sinkIndex);
            cameraInstances.set(serial, camInst);
        }

        if (camInst.client) {
            ws.close(4009, 'Camera already in use for ' + serial);
            return;
        }

        camInst.start(ws);
        return;
    }

    // Camera state subscription: browser subscribes to camera active/inactive changes
    const cameraStateMatch = url.pathname.match(/^\/camera-state\/(.+)$/);
    if (cameraStateMatch) {
        const serial = decodeURIComponent(cameraStateMatch[1]);
        console.log('[camera-state] Subscriber connected for ' + serial);
        cameraStateMonitor.subscribe(serial, ws);

        ws.on('close', () => {
            console.log('[camera-state] Subscriber disconnected for ' + serial);
        });
        return;
    }

    ws.close(4000, 'Invalid path');
});

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
