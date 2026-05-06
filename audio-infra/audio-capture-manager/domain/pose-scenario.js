// audio-infra/audio-capture-manager/pose-scenario.js
//
// Continuous pose scenario simulator: drives setPhysicalModel(ROTATION) at
// a high tick rate to imitate phone movement during walking / cycling /
// driving. Designed to run alongside the existing single-shot pose API and
// the GPS walk simulator without conflict.
//
// Lifecycle: idle -> running -> (paused <-> running)*  (no automatic finish)
// Stop is always explicit (UI Stop button or another module overriding).
//
// Conflict policy with single-shot pose:
//   - startScenario() always stops any current scenario for the serial.
//   - manager.js is expected to call stopScenario(serial) inside the
//     existing /api/pose/:serial single-shot handler, so a manual Apply
//     of pitch/yaw/roll cancels any active scenario (same pattern as
//     walk vs gps).
//
// Tick architecture:
//   We do NOT use the existing setDevicePoseRotation() for ticks because it
//   waits 500ms and does three readbacks - fine for a one-shot UI call,
//   fatal at 10 Hz. Instead each session opens its own gRPC client and
//   sends bare setPhysicalModel(ROTATION) calls without readback. The
//   readback path is reserved for diagnostics (start logging).

const grpc = require('@grpc/grpc-js');
const log = require('../log').getLogger('domain/pose-scenario');

// ============================================================
// CONFIG - tweak here, no logic changes needed.
// ============================================================

// Tick rate. 10 Hz gives smooth gravity vector animation.
// Lower this if 10 Hz looks like overkill on the box; raise it for finer
// motion. setPhysicalModel itself is cheap when called without readback.
const TICK_HZ                = 10;
const TICK_INTERVAL_MS       = Math.round(1000 / TICK_HZ);

// Scenario definitions. Each is a base pose + per-axis oscillators.
// Oscillator: { type: 'sin' | 'noise', amp: degrees, freq: Hz, phase: radians }
//   - 'sin' is a smooth sine wave (deterministic phase progression)
//   - 'noise' is uniform random +/- amp regenerated every tick (broadband)
// Multiple oscillators per axis are summed.
//
// Base pose convention (matches existing pose semantics):
//   pitch - tilt forward/back   (positive = top of phone falls back)
//   yaw   - rotation around vertical (heading-like)
//   roll  - left/right sideways tilt
const SCENARIOS = {
    walking: {
        label: 'Walking (in pocket)',
        // Phone in jeans pocket, screen against thigh, top up, slight forward lean.
        base: { pitch: 75, yaw: 0, roll: 0 },
        oscillators: {
            // Step cadence ~2 Hz. Pitch swings as the leg goes back and forth.
            pitch: [{ type: 'sin', amp: 5,   freq: 2.0, phase: 0 }],
            // Yaw drifts very slowly (heading wobble while walking).
            yaw:   [{ type: 'sin', amp: 5,   freq: 0.07, phase: 0 }],
            // Body sway is half the step cadence with 90 deg phase offset.
            roll:  [{ type: 'sin', amp: 3,   freq: 1.0, phase: Math.PI / 2 }],
        },
    },

    cycling: {
        label: 'Cycling (in jacket pocket)',
        base: { pitch: 65, yaw: 0, roll: 0 },
        oscillators: {
            // Pedal cadence ~0.8 Hz. Body rocks side to side strongly.
            roll:  [
                { type: 'sin',   amp: 12, freq: 0.8, phase: 0 },
                { type: 'noise', amp: 1.0 }, // road vibration
            ],
            pitch: [
                { type: 'sin',   amp: 3,  freq: 0.8, phase: Math.PI / 2 },
                { type: 'noise', amp: 0.7 },
            ],
            // Steering: occasional larger yaw sweep.
            yaw:   [{ type: 'sin', amp: 10, freq: 0.05, phase: 0 }],
        },
    },

    driving: {
        label: 'Driving (in dashboard mount)',
        base: { pitch: 45, yaw: 0, roll: 0 },
        oscillators: {
            // Engine + road broadband noise on every axis.
            pitch: [{ type: 'noise', amp: 0.5 }],
            yaw:   [
                { type: 'noise', amp: 0.5 },
                { type: 'sin',   amp: 15, freq: 0.025, phase: 0 }, // road curvature
            ],
            roll:  [
                { type: 'noise', amp: 0.5 },
                { type: 'sin',   amp: 2,  freq: 0.05, phase: 0 },  // turn lean
            ],
        },
        // Random impulse "bumps" on the road.
        bumps: {
            enabled:    true,
            avgPerMin:  1.5,
            ampDeg:     5.0,
            decayMs:    300,
        },
    },
};

const ALLOWED_SCENARIOS = new Set(Object.keys(SCENARIOS));

// ============================================================
// State
// ============================================================

const sessions = new Map(); // serial -> session

// Injected from manager.js to avoid circular requires.
let _emulatorProto = null;
let _callUnaryGrpc = null;
let _getGrpcAddressFromSerial = null;
let _setDevicePoseRotation = null;  // heavy version, used only at start

function init(deps) {
    _emulatorProto = deps.emulatorProto;
    _callUnaryGrpc = deps.callUnaryGrpc;
    _getGrpcAddressFromSerial = deps.getGrpcAddressFromSerial;
    _setDevicePoseRotation = deps.setDevicePoseRotation;
}

// ============================================================
// Helpers
// ============================================================

function clamp180(v) {
    let x = v;
    while (x > 180)  x -= 360;
    while (x < -180) x += 360;
    return x;
}

// Compute current axis offsets for a session at relative time t (seconds).
function computeOffsets(session, t) {
    const def = session.def;

    function evalAxis(oscList) {
        let sum = 0;
        if (!oscList) return 0;
        for (const o of oscList) {
            if (o.type === 'sin') {
                sum += o.amp * Math.sin(2 * Math.PI * o.freq * t + (o.phase || 0));
            } else if (o.type === 'noise') {
                sum += o.amp * (Math.random() * 2 - 1);
            }
        }
        return sum;
    }

    let dp = evalAxis(def.oscillators.pitch);
    let dy = evalAxis(def.oscillators.yaw);
    let dr = evalAxis(def.oscillators.roll);

    // Apply active bumps (driving scenario).
    if (def.bumps && def.bumps.enabled && session.activeBumps.length > 0) {
        const now = Date.now();
        let bumpPitch = 0;
        for (let i = session.activeBumps.length - 1; i >= 0; i--) {
            const b = session.activeBumps[i];
            const age = now - b.startedAt;
            if (age >= def.bumps.decayMs * 5) {
                session.activeBumps.splice(i, 1);
                continue;
            }
            // Asymmetric impulse: fast rise, exponential decay.
            const rise = Math.min(1, age / 50);
            const decay = Math.exp(-Math.max(0, age - 50) / def.bumps.decayMs);
            bumpPitch += b.amp * rise * decay;
        }
        dp += bumpPitch;
    }

    return { dPitch: dp, dYaw: dy, dRoll: dr };
}

function maybeSpawnBump(session, dt) {
    const def = session.def;
    if (!def.bumps || !def.bumps.enabled) return;
    const p = (def.bumps.avgPerMin / 60) * (dt / 1000);
    if (Math.random() < p) {
        const sign = Math.random() < 0.5 ? 1 : -1;
        const k = 0.8 + Math.random() * 0.4;
        session.activeBumps.push({
            startedAt: Date.now(),
            amp:       sign * def.bumps.ampDeg * k,
        });
    }
}

// ============================================================
// gRPC wiring
// ============================================================

function makeGrpcClient(serial) {
    const grpcAddress = _getGrpcAddressFromSerial(serial);
    const client = new _emulatorProto.EmulatorController(
        grpcAddress,
        grpc.credentials.createInsecure()
    );
    return { client: client, address: grpcAddress };
}

// Lightweight setRotation - no readback, no delay. Used by the ticker.
async function applyRotationFast(client, pitch, yaw, roll) {
    await _callUnaryGrpc(client, 'setPhysicalModel', {
        target: 'ROTATION',
        value: { data: [pitch, yaw, roll] },
    });
}

// ============================================================
// Lifecycle
// ============================================================

function statusSnapshot(session) {
    if (!session) return null;
    const now = Date.now();
    const liveElapsedMs = session.status === 'running'
        ? session.elapsedMs + (now - session.lastResumedAt)
        : session.elapsedMs;
    return {
        serial:        session.serial,
        scenario:      session.scenarioName,
        scenarioLabel: session.def.label,
        status:        session.status,
        base:          session.def.base,
        tickHz:        TICK_HZ,
        elapsedMs:     liveElapsedMs,
        startedAt:     session.startedAt,
        currentPose:   session.lastApplied || null,
        lastError:     session.lastError,
    };
}

async function startScenario(serial, opts) {
    opts = opts || {};
    if (!_emulatorProto || !_callUnaryGrpc || !_getGrpcAddressFromSerial || !_setDevicePoseRotation) {
        throw new Error('pose-scenario not initialized');
    }
    const name = opts.scenario;
    if (!name || !ALLOWED_SCENARIOS.has(name)) {
        throw new Error('scenario must be one of: ' + Array.from(ALLOWED_SCENARIOS).join(', '));
    }
    const def = SCENARIOS[name];

    // Drop previous scenario for this serial.
    stopScenario(serial);

    let grpcConn;
    try {
        grpcConn = makeGrpcClient(serial);
    } catch (err) {
        throw new Error('failed to create gRPC client: ' + err.message);
    }

    const now = Date.now();
    const session = {
        serial:           serial,
        scenarioName:     name,
        def:              def,
        status:           'running',
        grpcClient:       grpcConn.client,
        grpcAddress:      grpcConn.address,
        elapsedMs:        0,
        lastResumedAt:    now,
        startedAt:        new Date(now).toISOString(),
        activeBumps:      [],
        timer:            null,
        applying:         false,
        lastApplied:      null,
        lastError:        null,
        lastErrorLoggedAt: 0,
    };
    sessions.set(serial, session);

    log.info({ serial, scenario: name, base: def.base, tickHz: TICK_HZ, grpcAddress: grpcConn.address }, 'Starting scenario');

    // Apply the base pose once via the heavy path so we get a calibration log.
    try {
        const initial = await _setDevicePoseRotation(serial, def.base.pitch, def.base.yaw, def.base.roll);
        log.info({ serial, acc: initial.acceleration, orientation: initial.orientation }, 'Calibration: base pose applied');
        session.lastApplied = { pitch: def.base.pitch, yaw: def.base.yaw, roll: def.base.roll };
    } catch (err) {
        log.error({ serial, err: err.message }, 'Initial calibration failed');
        session.lastError = 'initial: ' + err.message;
    }

    session.timer = setInterval(function() { void tick(serial); }, TICK_INTERVAL_MS);
    return statusSnapshot(session);
}

async function tick(serial) {
    const session = sessions.get(serial);
    if (!session || session.status !== 'running') return;
    if (session.applying) return;
    session.applying = true;
    try {
        const now = Date.now();
        const tWall = (session.elapsedMs + (now - session.lastResumedAt)) / 1000;
        const dt = TICK_INTERVAL_MS;

        maybeSpawnBump(session, dt);

        const offs = computeOffsets(session, tWall);
        const pitch = clamp180(session.def.base.pitch + offs.dPitch);
        const yaw   = clamp180(session.def.base.yaw   + offs.dYaw);
        const roll  = clamp180(session.def.base.roll  + offs.dRoll);

        await applyRotationFast(session.grpcClient, pitch, yaw, roll);
        session.lastApplied = { pitch: pitch, yaw: yaw, roll: roll };
        session.lastError = null;
    } catch (err) {
        session.lastError = err.message;
        // Don't spam the log on every failed tick - log once per minute at most.
        const now = Date.now();
        if (now - session.lastErrorLoggedAt > 60000) {
            log.error({ serial, err: err.message }, 'Tick failed');
            session.lastErrorLoggedAt = now;
        }
    } finally {
        session.applying = false;
    }
}

function pauseScenario(serial) {
    const session = sessions.get(serial);
    if (!session) return false;
    if (session.status !== 'running') return false;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    session.elapsedMs += Date.now() - session.lastResumedAt;
    session.status = 'paused';
    // No keepalive needed - last applied rotation stays as emulator state.
    // Unlike GPS, pose state does not "expire".
    log.info({ serial, elapsedSec: Math.round(session.elapsedMs / 1000) }, 'Scenario paused');
    return true;
}

function resumeScenario(serial) {
    const session = sessions.get(serial);
    if (!session) return false;
    if (session.status !== 'paused') return false;
    session.status = 'running';
    session.lastResumedAt = Date.now();
    session.timer = setInterval(function() { void tick(serial); }, TICK_INTERVAL_MS);
    log.info({ serial }, 'Scenario resumed');
    return true;
}

function stopScenario(serial) {
    const session = sessions.get(serial);
    if (!session) return false;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    try {
        if (session.grpcClient && typeof session.grpcClient.close === 'function') {
            session.grpcClient.close();
        }
    } catch (e) { /* ignore */ }
    sessions.delete(serial);
    log.info({ serial }, 'Scenario stopped');
    return true;
}

function getStatus(serial) {
    return statusSnapshot(sessions.get(serial));
}

function getAllStatuses() {
    const out = {};
    for (const [serial, session] of sessions) {
        out[serial] = statusSnapshot(session);
    }
    return out;
}

function listScenarios() {
    const out = {};
    for (const k of Object.keys(SCENARIOS)) {
        out[k] = { label: SCENARIOS[k].label, base: SCENARIOS[k].base };
    }
    return out;
}

function shutdown() {
    for (const serial of Array.from(sessions.keys())) {
        stopScenario(serial);
    }
}

module.exports = {
    init: init,
    startScenario: startScenario,
    pauseScenario: pauseScenario,
    resumeScenario: resumeScenario,
    stopScenario: stopScenario,
    getStatus: getStatus,
    getAllStatuses: getAllStatuses,
    listScenarios: listScenarios,
    shutdown: shutdown,
    SCENARIOS: SCENARIOS,
    TICK_HZ: TICK_HZ,
};
