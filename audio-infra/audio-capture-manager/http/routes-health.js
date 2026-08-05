'use strict';

const { instances, cameraInstances, gpsSessions, poseStates, lightStates } = require('../stores');
const { AUTO_DISCOVER, isSerialAllowed, SINGLE_MODE } = require('../config');
const { paMonitor } = require('../pulse-monitor');
const { micStateMonitor } = require('../mic/state-monitor');
const { cameraStateMonitor } = require('../camera/state-monitor');
const { getGpsSessionsStatus } = require('../domain/gps');
const { getPoseStatesStatus } = require('../domain/pose');
const { getLightStatesStatus } = require('../domain/light');

function filterBySerial(obj) {
    if (!SINGLE_MODE) return obj;
    for (const serial of Object.keys(obj)) {
        if (!isSerialAllowed(serial)) delete obj[serial];
    }
    return obj;
}

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [system]
 *     operationId: getHealth
 *     summary: Liveness probe and process counters
 *     description: |
 *       Read-only. This is the container's healthcheck endpoint and the only JSON route that is
 *       exempt from authentication, so it answers 200 with no token even when `AUTH_REQUIRED=1`.
 *       The counters describe this manager process, not the emulator.
 *     security: []
 *     responses:
 *       '200':
 *         description: The manager is up.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HealthStatus' }
 *             example:
 *               status: ok
 *               instances: 1
 *               gpsSessions: 0
 *               poseStates: 1
 *               lightStates: 1
 *               autoDiscovery: true
 *               knownQemuInputs: 0
 *
 * /capture/status:
 *   get:
 *     tags: [system]
 *     operationId: getCaptureStatus
 *     summary: Audio-capture, microphone and camera state
 *     description: |
 *       Read-only snapshot of the media pipelines, keyed by serial. In SINGLE_MODE the maps are
 *       filtered to this manager's own serial.
 *
 *       There is no serial in the path, so the per-device ownership check does not run for this
 *       endpoint; the Bearer check still does.
 *     responses:
 *       '200':
 *         description: Current pipeline state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CaptureStatus' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /gps/status:
 *   get:
 *     tags: [gps]
 *     operationId: getGpsSessions
 *     summary: Active mock-location keepalive sessions
 *     description: |
 *       Read-only. Lists the GPS keepalive sessions this manager is running, filtered to its own
 *       serial in SINGLE_MODE. No serial in the path, so no ownership check.
 *     responses:
 *       '200':
 *         description: Session snapshot.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GpsSessionsStatus' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /pose/status:
 *   get:
 *     tags: [sensors]
 *     operationId: getPoseStates
 *     summary: Last applied device rotation per serial
 *     description: |
 *       Read-only. Reports the most recent single-shot rotation applied through this manager, not
 *       a live sensor read. For continuous motion sessions see `/pose/scenario/status`.
 *       No serial in the path, so no ownership check.
 *     responses:
 *       '200':
 *         description: Pose snapshot.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseStatesStatus' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /light/status:
 *   get:
 *     tags: [sensors]
 *     operationId: getLightStates
 *     summary: Last applied ambient-light value per serial
 *     description: |
 *       Read-only. Reports the most recent light value applied through this manager, including
 *       which transport carried it. No serial in the path, so no ownership check.
 *     responses:
 *       '200':
 *         description: Light snapshot.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LightStatesStatus' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 */
function handleHealth(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            instances: instances.size,
            gpsSessions: gpsSessions.size,
            poseStates: poseStates.size,
            lightStates: lightStates.size,
            autoDiscovery: AUTO_DISCOVER,
            knownQemuInputs: paMonitor.knownSinkInputs.size,
        }));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/status') {
        const status = {};
        for (const [serial, inst] of instances) {
            if (!isSerialAllowed(serial)) continue;
            status[serial] = inst.toJSON();
        }
        const micStates = {};
        for (const [serial, state] of micStateMonitor.states) {
            if (!isSerialAllowed(serial)) continue;
            micStates[serial] = state;
        }
        const cameraStatus = {};
        for (const [serial, inst] of cameraInstances) {
            if (!isSerialAllowed(serial)) continue;
            cameraStatus[serial] = inst.toJSON();
        }
        const cameraStates = {};
        for (const [serial, state] of cameraStateMonitor.states) {
            if (!isSerialAllowed(serial)) continue;
            cameraStates[serial] = state;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ capture: status, micStates: micStates, camera: cameraStatus, cameraStates: cameraStates }, null, 2));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/gps/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: filterBySerial(getGpsSessionsStatus()),
        }, null, 2));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pose/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            poses: filterBySerial(getPoseStatesStatus()),
        }, null, 2));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/light/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            lights: filterBySerial(getLightStatesStatus()),
        }, null, 2));
        return true;
    }

    return false;
}

module.exports = { handleHealth };
