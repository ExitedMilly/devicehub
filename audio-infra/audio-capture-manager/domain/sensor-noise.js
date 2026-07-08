'use strict';

// Realistic sensor noise: while active, keeps every sensor "alive" — slightly
// jittering around a realistic value — instead of the emulator's tell-tale dead
// zeros/statics (gyroscope 0:0:0, temperature 0, humidity 0, light 0).
//
// Channel: the emulator console `sensor set` (via consoleExec, all sensors in ONE
// authenticated connection per tick). VERIFIED on the bench that the console and
// the gRPC physical model (setPhysicalModel, used by the light/pose operblocks)
// write the SAME sensor layer, last-write-wins.
//
// Operblock coordination via the scenario RESOURCE MODEL (not by reading the
// sensor back): a naive "read current + jitter on top" does NOT work — noise
// writes far more often than an operblock, so it always reads back its OWN value
// and would overwrite the operblock (bench-proven: light operblock=350 stayed at
// the noise base ~275). Instead the caller passes the set of resources currently
// OWNED by an operblock; noise SKIPS the sensors those resources drive and jitters
// only the free ones. Free sensors: `set = default + freshNoise` each tick (fixed
// base => no random-walk drift). When an operblock releases a resource, its sensors
// become free again and noise resumes jittering them.

const { consoleExec } = require('../console-client');
const log = require('../log').getLogger('domain/sensor-noise');

const TICK_MS = 350;            // update cadence (~3 Hz) — "alive" without spam
const CONSOLE_TIMEOUT_MS = 6000;

// Per-sensor config. base = realistic center; amp = jitter half-range per
// component; kind = vector (x:y:z) | scalar (v). Gravity sits on +Y here (emulator
// axis convention; baseline was ~0:9.77:0.81).
const SENSORS = {
    acceleration:                { kind: 'vector', base: [0, 9.8, 0.2],     amp: [0.03, 0.06, 0.03] },
    gyroscope:                   { kind: 'vector', base: [0, 0, 0],         amp: [0.004, 0.004, 0.004] },
    'magnetic-field':            { kind: 'vector', base: [1.5, 9.9, -47.6], amp: [0.3, 0.3, 0.3] },
    orientation:                 { kind: 'vector', base: [0, 0, 0],         amp: [0.2, 0.2, 0.2] },
    temperature:                 { kind: 'scalar', base: 25.0,    amp: 0.2 },
    proximity:                   { kind: 'scalar', base: 5,       amp: 0 },
    light:                       { kind: 'scalar', base: 250,     amp: 8 },
    pressure:                    { kind: 'scalar', base: 1013.25, amp: 0.3 },
    humidity:                    { kind: 'scalar', base: 45,      amp: 0.8 },
    'magnetic-field-uncalibrated': { kind: 'vector', base: [1.5, 9.9, -47.6], amp: [0.5, 0.5, 0.5] },
    'gyroscope-uncalibrated':      { kind: 'vector', base: [0, 0, 0],       amp: [0.006, 0.006, 0.006] },
    'acceleration-uncalibrated':   { kind: 'vector', base: [0, 9.8, 0.2],   amp: [0.05, 0.08, 0.05] },
};
const SENSOR_NAMES = Object.keys(SENSORS);

// Which sensors a scenario resource drives (so noise yields them to the operblock).
//   'light' -> the ambient light cycle (setPhysicalModel LIGHT)
//   'pose'  -> rotation / motion scenario (setPhysicalModel ROTATION drives the
//              accelerometer/orientation/magnetometer via the physics model)
const RESOURCE_SENSORS = {
    light: ['light'],
    pose: ['acceleration', 'orientation', 'magnetic-field',
           'acceleration-uncalibrated', 'magnetic-field-uncalibrated'],
    // temperature operblock (console `sensor set temperature`) — noise yields the
    // ambient temperature sensor so it holds the user-set value instead of ~25°C.
    temperature: ['temperature'],
};

const sessions = new Map(); // serial -> session

function jitter(amp) {
    return amp * (Math.random() * 2 - 1);
}

function fmt(n) {
    return Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString();
}

// Sensors to skip = union of RESOURCE_SENSORS for every owned resource.
function skippedSensors(owned) {
    const skip = new Set();
    for (const res of (owned || [])) {
        for (const s of (RESOURCE_SENSORS[res] || [])) skip.add(s);
    }
    return skip;
}

async function tick(serial) {
    const session = sessions.get(serial);
    if (!session || session.applying) return;
    session.applying = true;
    try {
        const skip = skippedSensors(session.owned);
        const cmds = [];
        for (const name of SENSOR_NAMES) {
            if (skip.has(name)) continue;              // operblock owns it — leave alone
            const cfg = SENSORS[name];
            let value;
            if (cfg.kind === 'vector') {
                value = cfg.base.map((b, i) => fmt(b + jitter(cfg.amp[i]))).join(':');
            } else {
                value = fmt(cfg.base + jitter(cfg.amp));
            }
            cmds.push('sensor set ' + name + ' ' + value);
        }
        if (cmds.length) {
            await consoleExec(serial, cmds, { timeoutMs: CONSOLE_TIMEOUT_MS });
        }
        session.lastTickAt = Date.now();
        session.lastError = null;
    } catch (err) {
        session.lastError = err.message;
        if (Date.now() - session.lastErrorLoggedAt > 60000) {
            log.error({ serial, err: err.message }, 'sensor-noise tick failed');
            session.lastErrorLoggedAt = Date.now();
        }
    } finally {
        session.applying = false;
    }
}

// owned: array of scenario resource names currently held by an operblock.
function start(serial, owned) {
    stop(serial);
    const session = {
        serial,
        owned: Array.isArray(owned) ? owned.slice() : [],
        applying: false,
        timer: null,
        startedAt: new Date().toISOString(),
        lastTickAt: null,
        lastError: null,
        lastErrorLoggedAt: 0,
    };
    sessions.set(serial, session);
    log.info({ serial, owned: session.owned, tickMs: TICK_MS }, 'sensor-noise started');
    session.timer = setInterval(function () { void tick(serial); }, TICK_MS);
    return getStatus(serial);
}

// Update the owned-resource set live (operblock started/stopped) without
// restarting the loop.
function setOwned(serial, owned) {
    const session = sessions.get(serial);
    if (!session) return false;
    session.owned = Array.isArray(owned) ? owned.slice() : [];
    return true;
}

function stop(serial) {
    const session = sessions.get(serial);
    if (!session) return false;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    sessions.delete(serial);
    log.info({ serial }, 'sensor-noise stopped');
    return true;
}

function isRunning(serial) {
    return sessions.has(serial);
}

function getStatus(serial) {
    const session = sessions.get(serial);
    if (!session) return { active: false };
    return {
        active: true,
        serial,
        owned: session.owned,
        skipped: Array.from(skippedSensors(session.owned)),
        sensors: SENSOR_NAMES.length,
        tickMs: TICK_MS,
        startedAt: session.startedAt,
        lastTickAt: session.lastTickAt,
        lastError: session.lastError,
    };
}

function shutdown() {
    for (const serial of Array.from(sessions.keys())) stop(serial);
}

module.exports = { start, stop, setOwned, isRunning, getStatus, shutdown, SENSORS, RESOURCE_SENSORS };
