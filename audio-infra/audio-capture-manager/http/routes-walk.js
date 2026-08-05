'use strict';

const walkSimulator = require('../domain/walk-simulator');
const log = require('../log').getLogger('http/routes-walk');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /walk/status:
 *   get:
 *     tags: [gps]
 *     operationId: getWalkSessions
 *     summary: Snapshot every walk session this manager is running
 *     description: |
 *       Returns a map of serial to walk snapshot for every session held in memory, including
 *       sessions in `paused` and `finished` state (a finished walk stays listed until it is
 *       stopped or a new one is started for that serial). An empty `sessions` object means no
 *       walk has been started since the manager came up.
 *
 *       No serial in the path, so the per-device ownership check does not run for this route —
 *       only the Bearer check. Read-only.
 *
 *       Not reachable through nginx `/manager-api`, which only routes paths carrying a serial.
 *     responses:
 *       '200':
 *         description: Current walk sessions, keyed by serial.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, const: true }
 *                 sessions:
 *                   type: object
 *                   additionalProperties: { $ref: '#/components/schemas/WalkStatus' }
 *             example:
 *               ok: true
 *               sessions:
 *                 'emulator-test3:5555':
 *                   serial: 'emulator-test3:5555'
 *                   status: running
 *                   profile: foot
 *                   nominalSpeed: 1.4
 *                   currentSpeed: 1.38
 *                   totalDistanceM: 1840
 *                   coveredDistanceM: 413
 *                   progress: 0.2243
 *                   etaSeconds: 1034
 *                   currentPoint: { lat: 55.75219, lon: 37.61988 }
 *                   targetPoint: { lat: 55.76041, lon: 37.60772 }
 *                   lastError: null
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /walk/{serial}/status:
 *   get:
 *     tags: [gps]
 *     operationId: getWalkStatus
 *     summary: Read the walk session of one device
 *     description: |
 *       Returns the walk snapshot for this serial: state (`running`, `paused`, `finished`),
 *       route length, distance covered, progress (0..1), ETA at the current speed, the point
 *       currently applied to the device and the route's end point.
 *
 *       `status` is `null` when no walk session exists for this serial — that is a 200, not a
 *       404. `lastError` carries the last tick failure (for example an adb error); it is cleared
 *       on the next successful tick, so a walk can be running with an error already resolved.
 *
 *       Read-only; safe to poll. The UI polls it about once per second while a walk runs.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: 'Walk snapshot, or `status: null` when nothing is running.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WalkActionResult' }
 *             examples:
 *               running:
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     status: running
 *                     profile: foot
 *                     nominalSpeed: 1.4
 *                     currentSpeed: 1.38
 *                     totalDistanceM: 1840
 *                     coveredDistanceM: 413
 *                     progress: 0.2243
 *                     etaSeconds: 1034
 *                     currentPoint: { lat: 55.75219, lon: 37.61988 }
 *                     targetPoint: { lat: 55.76041, lon: 37.60772 }
 *                     lastError: null
 *               none:
 *                 summary: No walk session for this serial
 *                 value: { ok: true, serial: 'emulator-test3:5555', status: null }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /walk/{serial}/start:
 *   post:
 *     tags: [gps]
 *     operationId: startWalk
 *     summary: Start a route walk that moves the mock location once per second
 *     description: |
 *       **Live device.** Builds a route between the given stops and then moves the device along
 *       it, applying a new mock location **every second** until the route ends. Any GPS keepalive
 *       and any walk already running for this serial are stopped first.
 *
 *       **Also starts a matching pose scenario.** The movement profile is mapped to an
 *       accelerometer scenario (`foot` → walking, `bike` → cycling, `driving` → driving) so the
 *       sensors agree with the movement. It is skipped when a pose scenario is already running —
 *       the walk never disturbs one it did not start — and the walk owns only what it started:
 *       that scenario is stopped and the device returned to a flat pose when the walk stops or
 *       finishes. A pose failure is logged but never breaks the walk.
 *
 *       **Coordinates use the short keys `lat` and `lon`**, both for `waypoints` and for
 *       `from`/`to`. Give either `waypoints` (2 or more stops) or `from` + `to`; anything else is
 *       a 400.
 *
 *       **Takes as long as the route lookup.** Routing goes to the public OSRM demo server with a
 *       10 s timeout, so a start can block for several seconds; on OSRM failure the manager falls
 *       back to a cached route for the same stops and profile if it has one, and only then fails.
 *       The response returns as soon as the route is built — the walk itself keeps running in the
 *       background, poll `/walk/{serial}/status` for progress.
 *
 *       Speed is either a number in m/s (0 < x < 100) or a preset: `walking` 1.4, `jogging` 2.5,
 *       `running` 4.0, `cycling` 5.5, `driving` 13.9. An unusable value falls back to `walking`.
 *       With `speedVariance` (default true) the speed is re-sampled within ±15 % every 5 s.
 *       `jitter` is off by default and `jitterMeters` is capped at 1 m.
 *
 *       With `keepAliveAfterFinish` (default true) the manager starts a GPS keepalive on the last
 *       point when the route ends, so the final fix does not go stale after ~20 s. That keepalive
 *       outlives the walk — clear it with `POST /gps/{serial}/stop`.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WalkStartRequest' }
 *           examples:
 *             fromTo:
 *               summary: Red Square to Tverskaya, on foot
 *               value:
 *                 from: { lat: 55.751244, lon: 37.618423 }
 *                 to: { lat: 55.764204, lon: 37.605600 }
 *                 profile: foot
 *                 speed: walking
 *             waypoints:
 *               summary: Multi-stop drive at 13.9 m/s
 *               value:
 *                 waypoints:
 *                   - { lat: 55.751244, lon: 37.618423 }
 *                   - { lat: 55.758000, lon: 37.610000 }
 *                   - { lat: 55.764204, lon: 37.605600 }
 *                 profile: driving
 *                 speed: 13.9
 *                 keepAliveAfterFinish: true
 *                 pauseAccelOnWalkPause: true
 *     responses:
 *       '200':
 *         description: Route built and the walk started. The body is the initial snapshot.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WalkActionResult' }
 *             example:
 *               ok: true
 *               serial: 'emulator-test3:5555'
 *               status:
 *                 serial: 'emulator-test3:5555'
 *                 status: running
 *                 profile: foot
 *                 nominalSpeed: 1.4
 *                 currentSpeed: 1.4
 *                 totalDistanceM: 1840
 *                 coveredDistanceM: 0
 *                 progress: 0
 *                 etaSeconds: 1314
 *                 currentPoint: { lat: 55.751244, lon: 37.618423 }
 *                 targetPoint: { lat: 55.764204, lon: 37.6056 }
 *                 lastError: null
 *       '400':
 *         description: |
 *           Bad stops (missing `from`/`to` and `waypoints`, or a point outside valid ranges), an
 *           invalid JSON body, or a route that could not be built. **Routing failures land here
 *           too, not on 502** — an OSRM error or timeout with no usable cached route is reported
 *           as a 400.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               noStops:
 *                 value: { ok: false, error: 'provide either {from,to} or {waypoints:[...]}' }
 *               badWaypoint:
 *                 value: { ok: false, error: 'invalid waypoint: {"lat":95,"lon":37.618423}' }
 *               routingFailed:
 *                 summary: OSRM unreachable and nothing cached for these stops
 *                 value: { ok: false, error: 'OSRM request timed out' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /walk/{serial}/pause:
 *   post:
 *     tags: [gps]
 *     operationId: pauseWalk
 *     summary: Pause a running walk and hold the current point
 *     description: |
 *       **Live device.** Stops the one-second ticker and freezes the walk at its current
 *       position. To keep that fix from ageing out after ~20 s, a GPS keepalive is started on the
 *       current point for the duration of the pause; resuming or stopping the walk drops it.
 *
 *       The auto-synced pose scenario keeps running through the pause unless the walk was started
 *       with `pauseAccelOnWalkPause: true`.
 *
 *       Takes no request body.
 *
 *       **A 200 does not mean the walk was paused.** `paused` is false when there is no session
 *       for this serial or it was not in `running` state; check the flag and the returned
 *       `status`, not the status code.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Request handled. Inspect `paused` to see whether anything changed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WalkActionResult' }
 *             examples:
 *               paused:
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   paused: true
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     status: paused
 *                     profile: foot
 *                     nominalSpeed: 1.4
 *                     currentSpeed: 1.38
 *                     totalDistanceM: 1840
 *                     coveredDistanceM: 413
 *                     progress: 0.2243
 *                     etaSeconds: 1034
 *                     currentPoint: { lat: 55.75219, lon: 37.61988 }
 *                     targetPoint: { lat: 55.76041, lon: 37.60772 }
 *                     lastError: null
 *               notRunning:
 *                 summary: Nothing running, or already paused
 *                 value: { ok: true, serial: 'emulator-test3:5555', paused: false, status: null }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /walk/{serial}/resume:
 *   post:
 *     tags: [gps]
 *     operationId: resumeWalk
 *     summary: Resume a paused walk from where it stopped
 *     description: |
 *       **Live device.** Drops the keepalive that held the paused point, restarts the
 *       one-second ticker and continues from the distance already covered — the pause duration is
 *       not counted, so the device does not jump forward on the first tick. If the walk paused
 *       the pose scenario (`pauseAccelOnWalkPause`), it is resumed as well.
 *
 *       Takes no request body.
 *
 *       **A 200 does not mean the walk resumed.** `resumed` is false when there is no session for
 *       this serial or it was not in `paused` state.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Request handled. Inspect `resumed` to see whether anything changed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WalkActionResult' }
 *             examples:
 *               resumed:
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   resumed: true
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     status: running
 *                     profile: foot
 *                     nominalSpeed: 1.4
 *                     currentSpeed: 1.38
 *                     totalDistanceM: 1840
 *                     coveredDistanceM: 413
 *                     progress: 0.2243
 *                     etaSeconds: 1034
 *                     currentPoint: { lat: 55.75219, lon: 37.61988 }
 *                     targetPoint: { lat: 55.76041, lon: 37.60772 }
 *                     lastError: null
 *               notPaused:
 *                 summary: No paused session for this serial
 *                 value: { ok: true, serial: 'emulator-test3:5555', resumed: false, status: null }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /walk/{serial}/stop:
 *   post:
 *     tags: [gps]
 *     operationId: stopWalk
 *     summary: Stop a walk and discard its session
 *     description: |
 *       **Live device.** Stops the ticker, forgets the session and — if the walk was paused —
 *       drops the keepalive that was holding the paused point. The pose scenario the walk
 *       auto-started is stopped and the accelerometer returned to a flat pose; a manually started
 *       scenario is left alone.
 *
 *       The device keeps the last coordinates that were applied. They are no longer refreshed, so
 *       they go stale after roughly 20 s unless you set a new location.
 *
 *       **After a walk finished on its own, the handoff keepalive survives this call.** A route
 *       that ran to its end with `keepAliveAfterFinish` starts a keepalive on the final point;
 *       stopping the (already finished) session does not cancel it. Use
 *       `POST /gps/{serial}/stop` to clear that.
 *
 *       Takes no request body. `stopped: false` means there was no session to stop — a normal
 *       result, not an error.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Request handled. Inspect `stopped` to see whether a session existed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/WalkActionResult' }
 *             examples:
 *               stopped:
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: true }
 *               nothingRunning:
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: false }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
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
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const status = walkSimulator.getStatus(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, status }));
        return true;
    }

    const walkStartMatch = url.pathname.match(/^\/api\/walk\/(.+)\/start$/);
    if (req.method === 'POST' && walkStartMatch) {
        const serial = decodeURIComponent(walkStartMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
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
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const ok = walkSimulator.pauseWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, paused: ok, status: walkSimulator.getStatus(serial) }));
        return true;
    }

    const walkResumeMatch = url.pathname.match(/^\/api\/walk\/(.+)\/resume$/);
    if (req.method === 'POST' && walkResumeMatch) {
        const serial = decodeURIComponent(walkResumeMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const ok = walkSimulator.resumeWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, resumed: ok, status: walkSimulator.getStatus(serial) }));
        return true;
    }

    const walkStopMatch = url.pathname.match(/^\/api\/walk\/(.+)\/stop$/);
    if (req.method === 'POST' && walkStopMatch) {
        const serial = decodeURIComponent(walkStopMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const stopped = walkSimulator.stopWalk(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial, stopped }));
        return true;
    }

    return false;
}

module.exports = { handleWalk };
