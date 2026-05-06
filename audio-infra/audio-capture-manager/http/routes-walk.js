'use strict';

const walkSimulator = require('../domain/walk-simulator');
const log = require('../log').getLogger('http/routes-walk');
const { readJsonBody } = require('./helpers');

function handleWalk(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/walk/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            sessions: walkSimulator.getAllStatuses(),
        }));
        return true;
    }

    const walkStatusOneMatch = url.pathname.match(/^\/api\/walk\/(.+)\/status$/);
    if (req.method === 'GET' && walkStatusOneMatch) {
        const serial = decodeURIComponent(walkStatusOneMatch[1]);
        const status = walkSimulator.getStatus(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, status }));
        return true;
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
                log.error({ serial, err: err.message }, 'Walk start failed');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    const walkPauseMatch = url.pathname.match(/^\/api\/walk\/(.+)\/pause$/);
    if (req.method === 'POST' && walkPauseMatch) {
        const serial = decodeURIComponent(walkPauseMatch[1]);
        const ok = walkSimulator.pauseWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, paused: ok, status: walkSimulator.getStatus(serial) }));
        return true;
    }

    const walkResumeMatch = url.pathname.match(/^\/api\/walk\/(.+)\/resume$/);
    if (req.method === 'POST' && walkResumeMatch) {
        const serial = decodeURIComponent(walkResumeMatch[1]);
        const ok = walkSimulator.resumeWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, resumed: ok, status: walkSimulator.getStatus(serial) }));
        return true;
    }

    const walkStopMatch = url.pathname.match(/^\/api\/walk\/(.+)\/stop$/);
    if (req.method === 'POST' && walkStopMatch) {
        const serial = decodeURIComponent(walkStopMatch[1]);
        const stopped = walkSimulator.stopWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, stopped }));
        return true;
    }

    return false;
}

module.exports = { handleWalk };
