'use strict';

// Per-device schedule API for the Type-2 scheduler.
//   GET  /api/schedule/<serial> -> { ok, events, scheduleActive, tzOffsetMin, fired }
//   POST /api/schedule/<serial> -> replace the whole schedule (body {events, scheduleActive, tzOffsetMin})
// Whole-set POST (like scenarios). The daemon reads these files on its own tick; the
// route only reads/writes them. `fired` (daemon-owned state) is returned read-only so
// the UI can show which `once` events already ran.

const scheduleStore = require('../domain/schedule-store');
const log = require('../log').getLogger('http/routes-schedule');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

function handleSchedule(req, res, url) {
    const match = url.pathname.match(/^\/api\/schedule\/([^/]+)$/);
    if (!match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        try {
            const schedule = scheduleStore.readSchedule();
            const state = scheduleStore.readState();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...schedule, fired: state.fired }));
        } catch (err) {
            log.error({ serial, err: err.message }, 'Failed to read schedule');
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then((body) => {
                // Require the full object with an events array so a malformed/empty POST
                // can't silently wipe every event + disable the scheduler.
                if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false, error: 'expected { events: [...], scheduleActive, tzOffsetMin }' }));
                    return;
                }
                const saved = scheduleStore.saveSchedule(body);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...saved }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to save schedule');
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleSchedule };
