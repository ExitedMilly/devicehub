const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');

const walkSimulator = require('./domain/walk-simulator');
const poseScenario = require('./domain/pose-scenario');
const backupLogical = require('./domain/backup-logical');

const config = require('./config');
const {
    MANAGER_PORT, PA_SERVER, MIC_PIPE_DIR,
    MIC_STATE_POLL_MS, CAMERA_V4L2_DEVICE,
    GPS_KEEPALIVE_INTERVAL_MS, PA_POLL_INTERVAL_MS, AUTO_DISCOVER, EMULATOR_MAP_RAW,
} = config;
const { instances, micRtcInstances, cameraInstances, gpsSessions, poseStates, lightStates } = require('./stores');
const { emulatorProto, getGrpcAddressFromSerial, callUnaryGrpc } = require('./grpc-client');
const { registry } = require('./emulator-registry');
const { paMonitor } = require('./pulse-monitor');
const { CaptureInstance } = require('./audio/capture');
const { micStateMonitor } = require('./mic/state-monitor');
const { cameraStateMonitor } = require('./camera/state-monitor');
const { stopCameraWriter, startGlobalBlackFeed } = require('./camera/writer');
const { WebRTCMicrophoneInstance } = require('./mic/webrtc');
const { CameraInstance } = require('./camera/instance');
const {
    normalizeGpsProvider, validateCoordinates, setMockGpsLocation,
    stopGpsKeepAlive, getGpsSessionsStatus, startGpsKeepAlive,
} = require('./domain/gps');
const {
    validatePoseAngles, getPoseStatesStatus, setDevicePoseRotation,
} = require('./domain/pose');
const {
    validateLightLux, getLightStatesStatus, setDeviceLight,
} = require('./domain/light');

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

// ===================== HTTP + WebSocket Server =====================
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}


const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }
   
    if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            instances: instances.size,
            gpsSessions: gpsSessions.size,
            poseStates: poseStates.size,
            lightStates: lightStates.size,
            autoDiscovery: AUTO_DISCOVER,
            knownQemuInputs: paMonitor.knownSinkInputs.size
        }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/status') {
        const status = {};
        for (const [serial, inst] of instances) status[serial] = inst.toJSON();
        // Include mic state per emulator (states are already keyed by serial)
        const micStates = {};
        for (const [serial, state] of micStateMonitor.states) {
            micStates[serial] = state;
        }
        const cameraStatus = {};
        for (const [serial, inst] of cameraInstances) cameraStatus[serial] = inst.toJSON();
        const cameraStates = {};
        for (const [serial, state] of cameraStateMonitor.states) {
            cameraStates[serial] = state;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ capture: status, micStates: micStates, camera: cameraStatus, cameraStates: cameraStates }, null, 2));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/gps/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: getGpsSessionsStatus(),
        }, null, 2));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pose/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            poses: getPoseStatesStatus(),
        }, null, 2));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/light/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        lights: getLightStatesStatus(),
    }, null, 2));
    return;
}
    

    // Manual start (still available, but auto-discovery handles it normally)
    if (req.method === 'POST' && url.pathname === '/api/capture/start') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial, sinkIndex } = JSON.parse(body);
                if (!serial || !sinkIndex) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial and sinkIndex required' })); return; }
                if (instances.has(serial)) {
                    const existing = instances.get(serial);
                    if (existing.state === 'running') {
                        res.writeHead(200);
                        res.end(JSON.stringify({ status: 'already_running', ...existing.toJSON() }));
                        return;
                    }
                    existing.stop();
                }
                const instance = new CaptureInstance(serial, sinkIndex);
                instances.set(serial, instance);
                instance.start();
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'started', ...instance.toJSON() }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/stop') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial } = JSON.parse(body);
                if (!serial) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial required' })); return; }
                const instance = instances.get(serial);
                if (!instance) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
                instance.stop();
                instances.delete(serial);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'stopped', serial }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return;
    }

    const gpsStopMatch = url.pathname.match(/^\/api\/gps\/(.+)\/stop$/);
    if (req.method === 'POST' && gpsStopMatch) {
        const serial = decodeURIComponent(gpsStopMatch[1]);
        walkSimulator.stopWalk(serial);
        const stopped = stopGpsKeepAlive(serial);

        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            serial,
            stopped,
        }));
        return;
    }

        const gpsMatch = url.pathname.match(/^\/api\/gps\/(.+)$/);
    if (req.method === 'POST' && gpsMatch) {
        const serial = decodeURIComponent(gpsMatch[1]);
        walkSimulator.stopWalk(serial);

        readJsonBody(req)
            .then(async (body) => {
                const keepAlive = !!body.keepAlive;
                const intervalMs = body.intervalMs || GPS_KEEPALIVE_INTERVAL_MS;

                let result;
                if (keepAlive) {
                    result = await startGpsKeepAlive(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps',
                        intervalMs
                    );
                } else {
                    stopGpsKeepAlive(serial);
                    const onceResult = await setMockGpsLocation(
                        serial,
                        body.latitude,
                        body.longitude,
                        body.provider || 'gps'
                    );
                    result = {
                        ...onceResult,
                        keepAlive: false,
                        intervalMs: null,
                    };
                }

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                console.error('[gps] Failed to apply GPS:', err.message);
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return;
    }

    // ----------------- WALK SIMULATION -----------------

if (req.method === 'GET' && url.pathname === '/api/walk/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        sessions: walkSimulator.getAllStatuses(),
    }));
    return;
}

const walkStatusOneMatch = url.pathname.match(/^\/api\/walk\/(.+)\/status$/);
if (req.method === 'GET' && walkStatusOneMatch) {
    const serial = decodeURIComponent(walkStatusOneMatch[1]);
    const status = walkSimulator.getStatus(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, status }));
    return;
}

const walkStartMatch = url.pathname.match(/^\/api\/walk\/(.+)\/start$/);
if (req.method === 'POST' && walkStartMatch) {
    const serial = decodeURIComponent(walkStartMatch[1]);
    readJsonBody(req)
        .then(async (body) => {
            const status = await walkSimulator.startWalk(serial, body || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial, status }));
        })
        .catch((err) => {
            console.error('[walk] start failed:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    return;
}

const walkPauseMatch = url.pathname.match(/^\/api\/walk\/(.+)\/pause$/);
if (req.method === 'POST' && walkPauseMatch) {
    const serial = decodeURIComponent(walkPauseMatch[1]);
    const ok = walkSimulator.pauseWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, paused: ok, status: walkSimulator.getStatus(serial) }));
    return;
}

const walkResumeMatch = url.pathname.match(/^\/api\/walk\/(.+)\/resume$/);
if (req.method === 'POST' && walkResumeMatch) {
    const serial = decodeURIComponent(walkResumeMatch[1]);
    const ok = walkSimulator.resumeWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, resumed: ok, status: walkSimulator.getStatus(serial) }));
    return;
}

const walkStopMatch = url.pathname.match(/^\/api\/walk\/(.+)\/stop$/);
if (req.method === 'POST' && walkStopMatch) {
    const serial = decodeURIComponent(walkStopMatch[1]);
    const stopped = walkSimulator.stopWalk(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial, stopped }));
    return;
}

// ----------------- POSE SCENARIO -----------------

if (req.method === 'GET' && url.pathname === '/api/pose/scenario/list') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        scenarios: poseScenario.listScenarios(),
        tickHz: poseScenario.TICK_HZ,
    }));
    return;
}

if (req.method === 'GET' && url.pathname === '/api/pose/scenario/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
        ok: true,
        sessions: poseScenario.getAllStatuses(),
    }));
    return;
}

    // ----------------- BACKUP (AVD snapshot) -----------------

    const backupRestoreMatch = url.pathname.match(/^\/api\/backup\/(.+)\/restore$/);
    if (req.method === 'POST' && backupRestoreMatch) {
        const serial = decodeURIComponent(backupRestoreMatch[1]);
        backupLogical.restoreBackup(serial)
            .then(function(report) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, report: report }));
            })
            .catch(function(err) {
                console.error('[restore] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }

    const backupStatusMatch = url.pathname.match(/^\/api\/backup\/(.+)\/status$/);
    if (req.method === 'GET' && backupStatusMatch) {
        const serial = decodeURIComponent(backupStatusMatch[1]);
        try {
            const status = backupLogical.getBackupStatus(serial);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    

    const backupCreateMatch = url.pathname.match(/^\/api\/backup\/(.+)$/);
    if (req.method === 'POST' && backupCreateMatch) {
        const serial = decodeURIComponent(backupCreateMatch[1]);
        backupLogical.createBackup(serial)
            .then(function(result) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, result: result }));
            })
            .catch(function(err) {
                console.error('[backup] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }


const poseScStatusOneMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/status$/);
if (req.method === 'GET' && poseScStatusOneMatch) {
    const serial = decodeURIComponent(poseScStatusOneMatch[1]);
    const status = poseScenario.getStatus(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
    return;
}

const poseScStartMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/start$/);
if (req.method === 'POST' && poseScStartMatch) {
    const serial = decodeURIComponent(poseScStartMatch[1]);
    readJsonBody(req)
        .then(async (body) => {
            const status = await poseScenario.startScenario(serial, body || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        })
        .catch((err) => {
            console.error('[pose-scenario] start failed:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    return;
}

const poseScPauseMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/pause$/);
if (req.method === 'POST' && poseScPauseMatch) {
    const serial = decodeURIComponent(poseScPauseMatch[1]);
    const ok = poseScenario.pauseScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, paused: ok, status: poseScenario.getStatus(serial) }));
    return;
}

const poseScResumeMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/resume$/);
if (req.method === 'POST' && poseScResumeMatch) {
    const serial = decodeURIComponent(poseScResumeMatch[1]);
    const ok = poseScenario.resumeScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, resumed: ok, status: poseScenario.getStatus(serial) }));
    return;
}

const poseScStopMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/stop$/);
if (req.method === 'POST' && poseScStopMatch) {
    const serial = decodeURIComponent(poseScStopMatch[1]);
    const stopped = poseScenario.stopScenario(serial);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, serial: serial, stopped: stopped }));
    return;
}

    const poseMatch = url.pathname.match(/^\/api\/pose\/(.+)$/);
    if (req.method === 'POST' && poseMatch) {
        const serial = decodeURIComponent(poseMatch[1]);
        poseScenario.stopScenario(serial);

        readJsonBody(req)
            .then(async (body) => {
                const result = await setDevicePoseRotation(
                    serial,
                    body.pitch,
                    body.yaw,
                    body.roll
                );

                res.writeHead(200);
                res.end(JSON.stringify({
                    ok: true,
                    ...result,
                }));
            })
            .catch((err) => {
                console.error('[pose] Failed to apply pose:', err.message);
                res.writeHead(400);
                res.end(JSON.stringify({
                    ok: false,
                    error: err.message,
                }));
            });

        return;
    }

    const lightMatch = url.pathname.match(/^\/api\/light\/(.+)$/);
    if (req.method === 'POST' && lightMatch) {
    const serial = decodeURIComponent(lightMatch[1]);

    readJsonBody(req)
        .then(async (body) => {
            const result = await setDeviceLight(serial, body.lux);

            res.writeHead(200);
            res.end(JSON.stringify({
                ok: true,
                ...result,
            }));
        })
        .catch((err) => {
            console.error('[light] Failed to apply light:', err.message);
            res.writeHead(400);
            res.end(JSON.stringify({
                ok: false,
                error: err.message,
            }));
        });

    return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
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
