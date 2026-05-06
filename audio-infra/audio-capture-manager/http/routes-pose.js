'use strict';

const poseScenario = require('../domain/pose-scenario');
const { setDevicePoseRotation } = require('../domain/pose');
const { readJsonBody } = require('./helpers');

function handlePose(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pose/scenario/list') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            scenarios: poseScenario.listScenarios(),
            tickHz: poseScenario.TICK_HZ,
        }));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/pose/scenario/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: poseScenario.getAllStatuses(),
        }));
        return true;
    }

    const poseScStatusOneMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/status$/);
    if (req.method === 'GET' && poseScStatusOneMatch) {
        const serial = decodeURIComponent(poseScStatusOneMatch[1]);
        const status = poseScenario.getStatus(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        return true;
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
        return true;
    }

    const poseScPauseMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/pause$/);
    if (req.method === 'POST' && poseScPauseMatch) {
        const serial = decodeURIComponent(poseScPauseMatch[1]);
        const ok = poseScenario.pauseScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, paused: ok, status: poseScenario.getStatus(serial) }));
        return true;
    }

    const poseScResumeMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/resume$/);
    if (req.method === 'POST' && poseScResumeMatch) {
        const serial = decodeURIComponent(poseScResumeMatch[1]);
        const ok = poseScenario.resumeScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, resumed: ok, status: poseScenario.getStatus(serial) }));
        return true;
    }

    const poseScStopMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/stop$/);
    if (req.method === 'POST' && poseScStopMatch) {
        const serial = decodeURIComponent(poseScStopMatch[1]);
        const stopped = poseScenario.stopScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, stopped: stopped }));
        return true;
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

        return true;
    }

    return false;
}

module.exports = { handlePose };
