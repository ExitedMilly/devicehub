'use strict';

const poseScenario = require('../domain/pose-scenario');
const log = require('../log').getLogger('http/routes-pose');
const { setDevicePoseRotation } = require('../domain/pose');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /pose/scenario/list:
 *   get:
 *     tags: [sensors]
 *     operationId: listPoseScenarios
 *     summary: List the built-in continuous motion scenarios
 *     description: |
 *       Read-only catalogue of the motion profiles this manager can drive: `walking`,
 *       `cycling` and `driving`. Each entry carries a human label and the base pose
 *       (pitch/yaw/roll in degrees) the oscillators are applied on top of. `tickHz` is the fixed
 *       rate the ticker runs at (10 Hz).
 *
 *       The list is static — it comes from the module's scenario table, not from device state, so
 *       the answer is the same for every instance. There is no serial in the path, so the
 *       per-device ownership check does not run; the Bearer check still does.
 *     responses:
 *       '200':
 *         description: The scenario catalogue.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioListResult' }
 *             example:
 *               ok: true
 *               scenarios:
 *                 walking:
 *                   label: Walking (in pocket)
 *                   base: { pitch: 75, yaw: 0, roll: 0 }
 *                 cycling:
 *                   label: Cycling (in jacket pocket)
 *                   base: { pitch: 65, yaw: 0, roll: 0 }
 *                 driving:
 *                   label: Driving (in dashboard mount)
 *                   base: { pitch: 45, yaw: 0, roll: 0 }
 *               tickHz: 10
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /pose/scenario/status:
 *   get:
 *     tags: [sensors]
 *     operationId: getPoseScenarioSessions
 *     summary: Status of every pose scenario session on this manager
 *     description: |
 *       Read-only. Returns a map of serial to session snapshot for every scenario currently held
 *       in memory, running or paused. Sessions are not persisted — a manager restart empties the
 *       map and leaves the device at whatever rotation was last applied.
 *
 *       `sessions` is an empty object when nothing is running; that is the normal idle answer.
 *       Unlike `/pose/status`, this map is **not** filtered by SINGLE_MODE, but in practice a
 *       manager only drives its own instance.
 *
 *       A session can be `running` with every tick failing (emulator gone, gRPC refused). In that
 *       case the call still answers 200 — read `lastError` on the session before treating it as
 *       healthy.
 *
 *       No serial in the path, so no ownership check; the Bearer check still applies.
 *     responses:
 *       '200':
 *         description: Snapshot of all sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, const: true }
 *                 sessions:
 *                   type: object
 *                   additionalProperties: { type: object }
 *                   description: Keyed by serial. Empty when no scenario is running.
 *             example:
 *               ok: true
 *               sessions:
 *                 'emulator-test3:5555':
 *                   serial: 'emulator-test3:5555'
 *                   scenario: walking
 *                   scenarioLabel: Walking (in pocket)
 *                   status: running
 *                   base: { pitch: 75, yaw: 0, roll: 0 }
 *                   tickHz: 10
 *                   elapsedMs: 42300
 *                   startedAt: '2026-07-31T09:12:04.118Z'
 *                   currentPose: { pitch: 77.4, yaw: -1.2, roll: 2.8 }
 *                   lastError: null
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *
 * /pose/{serial}/scenario/status:
 *   get:
 *     tags: [sensors]
 *     operationId: getPoseScenario
 *     summary: Status of the pose scenario session for one device
 *     description: |
 *       Read-only. Returns the session snapshot for this serial, or `status: null` when no
 *       scenario is running or paused — `null` is the normal idle answer, not an error.
 *
 *       `elapsedMs` is live: it counts wall time while `running` and freezes while `paused`.
 *       `currentPose` is the last rotation actually pushed to the emulator, so it moves between
 *       two calls of a running session. `lastError` is the error of the most recent failed tick
 *       and is cleared as soon as a tick succeeds; a session can stay `running` while every tick
 *       fails, so a 200 here does not by itself mean the device is moving.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: 'Session snapshot, or `status: null` when idle.'
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioResult' }
 *             examples:
 *               running:
 *                 summary: Scenario in progress
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     scenario: cycling
 *                     scenarioLabel: Cycling (in jacket pocket)
 *                     status: running
 *                     base: { pitch: 65, yaw: 0, roll: 0 }
 *                     tickHz: 10
 *                     elapsedMs: 12800
 *                     startedAt: '2026-07-31T09:12:04.118Z'
 *                     currentPose: { pitch: 66.1, yaw: 3.4, roll: -9.7 }
 *                     lastError: null
 *               idle:
 *                 summary: No session for this serial
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   status: null
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /pose/{serial}/scenario/start:
 *   post:
 *     tags: [sensors]
 *     operationId: startPoseScenario
 *     summary: Start a continuous motion scenario on the device
 *     description: |
 *       **Live device.** Starts a ticker that rewrites the emulator's ROTATION physical model
 *       **10 times per second, continuously**, until it is explicitly stopped. The device's
 *       accelerometer, gyroscope and orientation sensors move for as long as the session lives —
 *       there is no automatic finish and no duration parameter. Try-it-out on an instance somebody
 *       is using will keep shaking their sensors until you call `/scenario/stop`.
 *
 *       The pose is the scenario's base pitch/yaw/roll plus per-axis sine and noise oscillators
 *       (the `driving` profile also injects random road bumps). Ticks are sent without readback,
 *       so the call itself returns quickly; only the one-off base pose at start goes through the
 *       heavy apply path (~0.5 s) to produce a calibration log line.
 *
 *       **Starting replaces any scenario already running for this serial** — the previous session
 *       is stopped first. This includes a session the GPS walk simulator auto-started: the walk
 *       keeps moving location, and it will still stop the replacement session when the walk ends.
 *
 *       `scenario` must be one of `walking`, `cycling`, `driving`; anything else is rejected with
 *       400, as is a manager whose gRPC wiring is not initialised.
 *
 *       **A 200 does not guarantee the device moved.** If the initial calibration apply fails the
 *       session is still created and started; the failure surfaces as `status.lastError`
 *       (prefixed `initial:`). Check that field, not just the status code.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PoseScenarioStartRequest' }
 *           examples:
 *             walking:
 *               summary: Phone in a trouser pocket
 *               value: { scenario: walking }
 *             driving:
 *               summary: Dashboard mount, road noise and bumps
 *               value: { scenario: driving }
 *     responses:
 *       '200':
 *         description: Session started. The body carries the first status snapshot.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioResult' }
 *             example:
 *               ok: true
 *               serial: 'emulator-test3:5555'
 *               status:
 *                 serial: 'emulator-test3:5555'
 *                 scenario: walking
 *                 scenarioLabel: Walking (in pocket)
 *                 status: running
 *                 base: { pitch: 75, yaw: 0, roll: 0 }
 *                 tickHz: 10
 *                 elapsedMs: 0
 *                 startedAt: '2026-07-31T09:12:04.118Z'
 *                 currentPose: { pitch: 75, yaw: 0, roll: 0 }
 *                 lastError: null
 *       '400':
 *         description: |
 *           Unknown or missing scenario name, a malformed JSON body, or the emulator gRPC client
 *           could not be created for this serial.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               unknownScenario:
 *                 value: { ok: false, error: 'scenario must be one of: walking, cycling, driving' }
 *               noGrpc:
 *                 value: { ok: false, error: 'failed to create gRPC client: invalid serial' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /pose/{serial}/scenario/pause:
 *   post:
 *     tags: [sensors]
 *     operationId: pausePoseScenario
 *     summary: Pause a running pose scenario
 *     description: |
 *       **Live device.** Stops the 10 Hz ticker and freezes the device at the rotation last
 *       applied — the pose does not return to flat and does not expire, so the sensors keep
 *       reporting that tilted position until the scenario is resumed, stopped or overwritten.
 *       `elapsedMs` stops advancing while paused.
 *
 *       Takes no request body. **`paused: false` is a normal answer, not an error**: it means
 *       there was no session for this serial or it was not in the `running` state (already
 *       paused). The call still returns 200 with `ok: true`, so the status code alone is not
 *       enough — read `paused` and the returned `status`.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Pause attempted. `paused` says whether anything changed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioResult' }
 *             examples:
 *               paused:
 *                 summary: Session moved to paused
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   paused: true
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     scenario: walking
 *                     scenarioLabel: Walking (in pocket)
 *                     status: paused
 *                     base: { pitch: 75, yaw: 0, roll: 0 }
 *                     tickHz: 10
 *                     elapsedMs: 42300
 *                     startedAt: '2026-07-31T09:12:04.118Z'
 *                     currentPose: { pitch: 77.4, yaw: -1.2, roll: 2.8 }
 *                     lastError: null
 *               noop:
 *                 summary: Nothing was running
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   paused: false
 *                   status: null
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /pose/{serial}/scenario/resume:
 *   post:
 *     tags: [sensors]
 *     operationId: resumePoseScenario
 *     summary: Resume a paused pose scenario
 *     description: |
 *       **Live device.** Restarts the 10 Hz ticker for a paused session; the device starts moving
 *       again from the point in the oscillator waveform where it was paused, and `elapsedMs`
 *       resumes counting.
 *
 *       Takes no request body. **`resumed: false` is a normal answer, not an error**: there was no
 *       session for this serial, or it was not in the `paused` state (already running). The call
 *       still returns 200 with `ok: true` — check `resumed` and the returned `status` rather than
 *       the status code.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Resume attempted. `resumed` says whether anything changed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioResult' }
 *             examples:
 *               resumed:
 *                 summary: Session moved back to running
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   resumed: true
 *                   status:
 *                     serial: 'emulator-test3:5555'
 *                     scenario: walking
 *                     scenarioLabel: Walking (in pocket)
 *                     status: running
 *                     base: { pitch: 75, yaw: 0, roll: 0 }
 *                     tickHz: 10
 *                     elapsedMs: 42300
 *                     startedAt: '2026-07-31T09:12:04.118Z'
 *                     currentPose: { pitch: 77.4, yaw: -1.2, roll: 2.8 }
 *                     lastError: null
 *               noop:
 *                 summary: Nothing was paused
 *                 value:
 *                   ok: true
 *                   serial: 'emulator-test3:5555'
 *                   resumed: false
 *                   status: null
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /pose/{serial}/scenario/stop:
 *   post:
 *     tags: [sensors]
 *     operationId: stopPoseScenario
 *     summary: Stop the pose scenario and drop the session
 *     description: |
 *       **Live device.** Cancels the ticker, closes the session's gRPC client and removes the
 *       session. Stop is the only way a scenario ends — there is no automatic finish.
 *
 *       **The device keeps the last applied rotation.** This endpoint does not return the pose to
 *       flat, so the accelerometer stays frozen at whatever tilt the last tick produced. Apply a
 *       neutral pose with `POST /pose/{serial}` (`pitch: 0, yaw: 0, roll: 0`) if a flat device is
 *       wanted afterwards. (The automatic teardown at the end of a GPS walk does reset to flat;
 *       this manual stop does not.)
 *
 *       Takes no request body. **`stopped: false` is a normal answer**, meaning there was no
 *       session for this serial; the call still returns 200 with `ok: true`.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Stop attempted. `stopped` is false when there was nothing to stop.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseScenarioResult' }
 *             examples:
 *               stopped:
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: true }
 *               noop:
 *                 summary: No session existed
 *                 value: { ok: true, serial: 'emulator-test3:5555', stopped: false }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /pose/{serial}:
 *   post:
 *     tags: [sensors]
 *     operationId: applyPose
 *     summary: Set a single fixed device rotation (pitch/yaw/roll)
 *     description: |
 *       **Live device.** Writes one ROTATION physical-model value to the emulator and leaves it
 *       there. Every rotation-derived sensor follows: the accelerometer's gravity vector, the
 *       gyroscope and the orientation sensor all report the new attitude to apps under test until
 *       something else changes it.
 *
 *       **Side effect: this also stops any running pose scenario for the serial.** The stop happens
 *       before the request body is parsed, so a request that is rejected with 400 has still killed
 *       the scenario. This mirrors the GPS/walk rule — a manual apply always wins over a
 *       continuous simulation. If a GPS walk auto-started that scenario, the walk keeps moving
 *       location but the device stops moving.
 *
 *       All three angles are required and must be finite numbers in `[-180, 180]`; anything else
 *       gives 400. The handler applies the value, waits 500 ms and then reads back the rotation,
 *       acceleration and orientation from the emulator, so a call takes roughly a second and the
 *       response body carries those readbacks — useful for confirming the emulator actually took
 *       the pose. The result is also cached and served by `GET /pose/status`.
 *
 *       This path is matched **last**, after all `/pose/{serial}/scenario/*` routes, so those are
 *       never swallowed by it.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PoseRequest' }
 *           examples:
 *             flat:
 *               summary: Flat on a table, screen up
 *               value: { pitch: 0, yaw: 0, roll: 0 }
 *             portraitUpright:
 *               summary: Held upright in portrait
 *               value: { pitch: 90, yaw: 0, roll: 0 }
 *             landscape:
 *               summary: Rotated into landscape
 *               value: { pitch: 0, yaw: 0, roll: 90 }
 *     responses:
 *       '200':
 *         description: Rotation applied. The body includes the post-apply sensor readbacks.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PoseResult' }
 *             example:
 *               ok: true
 *               serial: 'emulator-test3:5555'
 *               pitch: 0
 *               yaw: 0
 *               roll: 90
 *               appliedAt: '2026-07-31T09:14:22.507Z'
 *               rotation: [0, 0, 90]
 *               acceleration: [9.77, 0, 0]
 *               orientation: [0, 0, 90]
 *       '400':
 *         description: |
 *           Invalid angles (missing, not a number, or outside `[-180, 180]`), a malformed JSON
 *           body, or the gRPC apply failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               outOfRange:
 *                 value: { ok: false, error: 'roll must be between -180 and 180' }
 *               notANumber:
 *                 value: { ok: false, error: 'pitch must be a valid number' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
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
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const status = poseScenario.getStatus(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        return true;
    }

    const poseScStartMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/start$/);
    if (req.method === 'POST' && poseScStartMatch) {
        const serial = decodeURIComponent(poseScStartMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        readJsonBody(req)
            .then(async (body) => {
                const status = await poseScenario.startScenario(serial, body || {});
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
            })
            .catch((err) => {
                log.error({ serial: serial, err: err.message }, 'Pose scenario start failed');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    const poseScPauseMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/pause$/);
    if (req.method === 'POST' && poseScPauseMatch) {
        const serial = decodeURIComponent(poseScPauseMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const ok = poseScenario.pauseScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, paused: ok, status: poseScenario.getStatus(serial) }));
        return true;
    }

    const poseScResumeMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/resume$/);
    if (req.method === 'POST' && poseScResumeMatch) {
        const serial = decodeURIComponent(poseScResumeMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const ok = poseScenario.resumeScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, resumed: ok, status: poseScenario.getStatus(serial) }));
        return true;
    }

    const poseScStopMatch = url.pathname.match(/^\/api\/pose\/(.+)\/scenario\/stop$/);
    if (req.method === 'POST' && poseScStopMatch) {
        const serial = decodeURIComponent(poseScStopMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
        const stopped = poseScenario.stopScenario(serial);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, serial: serial, stopped: stopped }));
        return true;
    }

    const poseMatch = url.pathname.match(/^\/api\/pose\/(.+)$/);
    if (req.method === 'POST' && poseMatch) {
        const serial = decodeURIComponent(poseMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
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
                log.error({ serial: serial, err: err.message }, 'Failed to apply pose');
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
