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

/**
 * @openapi
 * /schedule/{serial}:
 *   get:
 *     tags: [scenarios]
 *     operationId: getSchedule
 *     summary: Read the scenario schedule and the daemon's fired state
 *     description: |
 *       Returns the whole schedule as stored on disk: `events`, the `scheduleActive` master
 *       switch, `tzOffsetMin`, and the daemon's `fired` map.
 *
 *       Each event is `{ id, time, scenarioId, repeat, maxJitterMin, enabled }`. `time` is a local
 *       `HH:MM` in the offset carried by `tzOffsetMin` — the container clock runs UTC, so the
 *       offset is what lets the daemon resolve a local wall-clock time. Events that fail
 *       validation on read (bad id, bad `HH:MM`, missing `scenarioId`) are dropped, and a missing
 *       or corrupt file reads as an empty, inactive schedule rather than an error.
 *
 *       **`fired` is daemon-owned and read-only here.** It maps `eventId -> YYYY-MM-DD`, the day
 *       an event last ran, and is what stops a `daily` event firing twice in a day and a `once`
 *       event firing ever again. It lives in a separate file so a whole-set POST of the schedule
 *       cannot clobber it, and it cannot be set through this API.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: The current schedule plus the daemon's anti-repeat state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Schedule' }
 *             example:
 *               ok: true
 *               events:
 *                 - id: ev-1
 *                   time: '09:00'
 *                   scenarioId: sc-m2x1p0-a7f3c1
 *                   repeat: daily
 *                   maxJitterMin: 15
 *                   enabled: true
 *               scheduleActive: true
 *               tzOffsetMin: 180
 *               fired: { 'ev-1': '2026-07-31' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500': { $ref: '#/components/responses/ServerError' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [scenarios]
 *     operationId: saveSchedule
 *     summary: Replace the whole schedule and arm the background scheduler
 *     description: |
 *       **Replaces the entire schedule**, it does not merge. The `events` array you send becomes
 *       the schedule; anything omitted is deleted.
 *
 *       **This arms an autonomous background daemon.** With `scheduleActive: true` the manager's
 *       minute tick applies the referenced scenarios at their configured times on its own — no
 *       browser open, no client connected — by calling the same apply path as
 *       `POST /scenarios/{serial}/apply`. Saving a schedule therefore schedules real changes to a
 *       live device for later. `scheduleActive: false` keeps the events but fires nothing.
 *
 *       **A body without an `events` array is a 400.** The full object is required so a malformed
 *       or empty request cannot silently wipe every event and disable the scheduler. To clear the
 *       schedule, send `events: []` explicitly.
 *
 *       `tzOffsetMin` exists because the container clock runs UTC while `time` is a local
 *       `HH:MM`. Send minutes east of UTC — the browser's `-getTimezoneOffset()`, so MSK is `180`.
 *       Omitting it means UTC, which will fire events at the wrong local hour. Values outside
 *       ±840 fall back to 0.
 *
 *       Per-event fields: `repeat` is `daily` (default) or `once`; `maxJitterMin` adds a
 *       deterministic per-event, per-day offset so a daily event does not fire at exactly the same
 *       minute (capped at 720); `enabled` defaults to true. Events are sanitized before the write
 *       and the response is the sanitized schedule actually persisted, so compare it with what you
 *       sent if an event is missing. The write is atomic, and the daemon re-reads the file each
 *       tick, so a change takes effect within about a minute without a restart.
 *
 *       The `fired` map is not part of this request and is untouched by it. Deleting an event and
 *       recreating it with the same id re-arms it, because the daemon prunes fired state for
 *       events that no longer exist.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ScheduleSaveRequest' }
 *           examples:
 *             dailyWithJitter:
 *               summary: One daily event at 09:00 MSK, up to 15 min of jitter
 *               value:
 *                 events:
 *                   - id: ev-1
 *                     time: '09:00'
 *                     scenarioId: sc-m2x1p0-a7f3c1
 *                     repeat: daily
 *                     maxJitterMin: 15
 *                     enabled: true
 *                 scheduleActive: true
 *                 tzOffsetMin: 180
 *             disarm:
 *               summary: Keep the events, stop firing them
 *               value:
 *                 events:
 *                   - id: ev-1
 *                     time: '09:00'
 *                     scenarioId: sc-m2x1p0-a7f3c1
 *                     repeat: daily
 *                     maxJitterMin: 15
 *                     enabled: true
 *                 scheduleActive: false
 *                 tzOffsetMin: 180
 *             clearAll:
 *               summary: Explicitly empty the schedule
 *               value: { events: [], scheduleActive: false, tzOffsetMin: 180 }
 *     responses:
 *       '200':
 *         description: |
 *           Saved. The body is the sanitized schedule that was written (without `fired`, which is
 *           only returned by the GET).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Schedule' }
 *             example:
 *               ok: true
 *               events:
 *                 - id: ev-1
 *                   time: '09:00'
 *                   scenarioId: sc-m2x1p0-a7f3c1
 *                   repeat: daily
 *                   maxJitterMin: 15
 *                   enabled: true
 *               scheduleActive: true
 *               tzOffsetMin: 180
 *       '400':
 *         description: The body was not an object with an `events` array.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'expected { events: [...], scheduleActive, tzOffsetMin }' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500': { $ref: '#/components/responses/ServerError' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
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
