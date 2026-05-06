'use strict';

const { instances, cameraInstances, gpsSessions, poseStates, lightStates } = require('../stores');
const { AUTO_DISCOVER } = require('../config');
const { paMonitor } = require('../pulse-monitor');
const { micStateMonitor } = require('../mic/state-monitor');
const { cameraStateMonitor } = require('../camera/state-monitor');
const { getGpsSessionsStatus } = require('../domain/gps');
const { getPoseStatesStatus } = require('../domain/pose');
const { getLightStatesStatus } = require('../domain/light');

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
        for (const [serial, inst] of instances) status[serial] = inst.toJSON();
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
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/gps/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: getGpsSessionsStatus(),
        }, null, 2));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pose/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            poses: getPoseStatesStatus(),
        }, null, 2));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/light/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            lights: getLightStatesStatus(),
        }, null, 2));
        return true;
    }

    return false;
}

module.exports = { handleHealth };
