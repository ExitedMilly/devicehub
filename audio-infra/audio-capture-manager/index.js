'use strict';

const log = require('./log').getLogger('index');
const walkSimulator = require('./domain/walk-simulator');
const poseScenario = require('./domain/pose-scenario');
const wifiAutoconnect = require('./domain/wifi-autoconnect');
const gpsInit = require('./domain/gps-init');
const cellInit = require('./domain/cell-init');
const scheduler = require('./domain/scheduler');
const backupLogical = require('./domain/backup-logical');

const config = require('./config');
const {
    MANAGER_PORT, PA_SERVER, MIC_PIPE_DIR,
    MIC_STATE_POLL_MS, CAMERA_V4L2_DEVICE,
    GPS_KEEPALIVE_INTERVAL_MS, PA_POLL_INTERVAL_MS, AUTO_DISCOVER, EMULATOR_MAP_RAW,
    SINGLE_MODE, INSTANCE_SERIAL, EMULATOR_ADB_HOST, EMULATOR_GRPC_HOST,
    AUTH_REQUIRED, STF_SECRET, WIFI_SSID, WIFI_PASSWORD, WIFI_MAC,
    INITIAL_LAT, INITIAL_LON, INITIAL_CELL,
} = config;

if (AUTH_REQUIRED && !STF_SECRET) {
    log.error('AUTH_REQUIRED=1 but STF_SECRET is not set — refusing to start');
    process.exit(1);
}
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

const { registry } = require('./emulator-registry');
const { CaptureInstance } = require('./audio/capture');
const { server } = require('./http/server');
const { attachWsServer } = require('./ws/server');
const { registerAppMetrics } = require('./metrics-app');

poseScenario.init({
    emulatorProto: emulatorProto,
    callUnaryGrpc: callUnaryGrpc,
    getGrpcAddressFromSerial: getGrpcAddressFromSerial,
    setDevicePoseRotation: setDevicePoseRotation,
});

// walk-simulator depends on poseScenario for accelerometer auto-sync, so it
// is initialized after poseScenario.init() above.
walkSimulator.init({
    setMockGpsLocation,
    startGpsKeepAlive,
    stopGpsKeepAlive,
    isScenarioRunning: poseScenario.isScenarioRunning,
    startScenario: poseScenario.startScenario,
    stopScenario: poseScenario.stopScenario,
    pauseScenario: poseScenario.pauseScenario,
    resumeScenario: poseScenario.resumeScenario,
    stopScenarioAndReset: poseScenario.stopScenarioAndReset,
});

registerAppMetrics();
attachWsServer(server);

// ===================== Startup =====================

server.listen(MANAGER_PORT, '0.0.0.0', () => {
    log.info({
        singleMode: SINGLE_MODE,
        instanceSerial: INSTANCE_SERIAL,
        emulatorAdbHost: EMULATOR_ADB_HOST,
        emulatorGrpcHost: EMULATOR_GRPC_HOST,
    }, SINGLE_MODE ? 'Running in SINGLE-INSTANCE mode' : 'Running in MULTI-INSTANCE mode (legacy)');
    log.info({ port: MANAGER_PORT }, 'Listening on port');
    log.info({ paServer: PA_SERVER }, 'PA_SERVER');
    log.info({ autoDiscover: AUTO_DISCOVER }, 'AUTO_DISCOVER');
    log.info({ pollMs: PA_POLL_INTERVAL_MS }, 'PA_POLL_INTERVAL');
    log.info({ pollMs: MIC_STATE_POLL_MS }, 'MIC_STATE_POLL');
    if (EMULATOR_MAP_RAW) {
        log.info({ emulatorMap: EMULATOR_MAP_RAW }, 'EMULATOR_MAP');
    }
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/' }, 'HTTP API');
    log.info({ url: 'ws://0.0.0.0:' + MANAGER_PORT + '/audio/{serial}' }, 'Audio WS');
    log.info({ url: 'ws://0.0.0.0:' + MANAGER_PORT + '/mic-rtc/{serial}' }, 'Mic RTC WS');
    log.info({ url: 'ws://0.0.0.0:' + MANAGER_PORT + '/mic-state/{serial}' }, 'Mic State WS');
    log.info({ url: 'ws://0.0.0.0:' + MANAGER_PORT + '/camera/{serial}' }, 'Camera WS');
    log.info({ url: 'ws://0.0.0.0:' + MANAGER_PORT + '/camera-state/{serial}' }, 'Camera State WS');
    log.info({ micPipeDir: MIC_PIPE_DIR }, 'MIC_PIPE_DIR');
    log.info({ device: CAMERA_V4L2_DEVICE }, 'CAMERA_V4L2_DEVICE');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/gps/{serial}' }, 'GPS API');
    log.info({ intervalMs: GPS_KEEPALIVE_INTERVAL_MS }, 'GPS keepalive interval');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}' }, 'Pose API');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/light/{serial}' }, 'Light API');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/walk/{serial}/(start|pause|resume|stop|status)' }, 'Walk API');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/pose/{serial}/scenario/(start|pause|resume|stop|status)' }, 'Pose Scenario API');
    log.info({ tickHz: poseScenario.TICK_HZ }, 'Pose Scenario tick');
    log.info({ url: 'http://0.0.0.0:' + MANAGER_PORT + '/api/backup/{serial}', dir: backupLogical.BACKUP_DIR }, 'Backup API');
    log.info({ backupDir: process.env.BACKUP_DIR || '/backups' }, 'Backup: logical (APK + /sdcard/)');
    // Start PA auto-discovery
    paMonitor.start();
    // Start mic state monitoring
    micStateMonitor.start();
    // Start camera state monitoring
    cameraStateMonitor.start();

    // Start black feed on v4l2loopback to keep camera alive for emulators
    startGlobalBlackFeed();

    // In single mode, manually bootstrap CaptureInstance since PAMonitor
    // auto-discovery is disabled.
    if (SINGLE_MODE) {
        const hostname = INSTANCE_SERIAL.split(':')[0];
        const info = registry.resolve(hostname);
        log.info({ serial: INSTANCE_SERIAL, sinkIndex: info.sinkIndex }, 'Bootstrapping CaptureInstance for single mode');
        const instance = new CaptureInstance(INSTANCE_SERIAL, info.sinkIndex);
        instances.set(INSTANCE_SERIAL, instance);
        instance.start();

        // If a custom Wi-Fi SSID is configured, auto-connect the device to it
        // after boot (background retry loop). No-op when WIFI_SSID is empty.
        wifiAutoconnect.start(INSTANCE_SERIAL, WIFI_SSID, WIFI_PASSWORD, WIFI_MAC);
        // NOTE: the default phone number is now baked into the SIM profile by the
        // emulator op-shim (EF_MSISDN), so there is no manager-side auto-apply.
        // The UI runtime path (routes-phonenumber -> setNumber) still works.
        // If an initial GPS location is configured, apply it after boot so the device
        // shows it instead of the emulator's Googleplex default. Just a starting value
        // — the user can override it in the UI. No-op when INITIAL_LAT/LON are unset.
        gpsInit.start(INSTANCE_SERIAL, INITIAL_LAT, INITIAL_LON);

        // If an initial serving cell is configured (op-v4 image only), apply it after
        // boot so the device starts on that tower. Operator is pinned to the SIM, so
        // it stays consistent with the instance's operator. No-op when unset.
        cellInit.start(INSTANCE_SERIAL, INITIAL_CELL);

        // Type-2 schedule daemon: applies saved scenarios at their scheduled time,
        // autonomously (no browser). Re-reads /backups/schedule.json + scenarios.json
        // every minute, so a restart self-heals. Fire-and-forget, scoped to this serial.
        scheduler.start(INSTANCE_SERIAL);
    }
});

function shutdown(signal) {
    log.info({ signal }, 'shutting down');
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
    scheduler.stop();
    server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Deliberately keep Node's fail-fast policy and only make the death legible.
// Swallowing these and carrying on would leave the manager holding state it can
// no longer reason about — a half-started capture instance, a keepalive timer
// pointing at a dead adb session — and every one of those is rebuilt from
// scratch on boot anyway, with the container restarted by Docker. What was
// missing is the record: an uncaught error went to stderr as a bare stack,
// outside the structured log, so a restart looked like it came from nowhere.
// No graceful shutdown() here on purpose: after an uncaught error its cleanup
// path is exactly as untrustworthy as everything else.
function dieOn(kind, err) {
    log.error({
        kind,
        err: err && err.message,
        stack: err && err.stack,
    }, 'fatal: unhandled error, exiting');
    process.exit(1);
}
process.on('uncaughtException', (err) => dieOn('uncaughtException', err));
process.on('unhandledRejection', (err) => dieOn('unhandledRejection', err));
