'use strict';

// Per-device schedule for the Type-2 scheduler daemon. Two files on the /backups
// host bind-mount (survive manager restart AND container recreation):
//   /backups/schedule.json        <- UI-owned: { events, scheduleActive, tzOffsetMin }
//   /backups/schedule-state.json  <- daemon-owned: { fired: { eventId: 'YYYY-MM-DD' } }
// They are SEPARATE so the UI's whole-set POST of schedule.json can never clobber the
// daemon's anti-repeat state. Same atomic write + resilient read as scenarios-store.js.

const fs = require('fs');
const log = require('../log').getLogger('domain/schedule-store');

const SCHEDULE_PATH = process.env.SCHEDULE_PATH || '/backups/schedule.json';
const STATE_PATH = process.env.SCHEDULE_STATE_PATH || '/backups/schedule-state.json';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM, minute granularity

function sanitizeEvent(e) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.id !== 'string' || !e.id) return null;
    if (typeof e.time !== 'string' || !TIME_RE.test(e.time)) return null;
    if (typeof e.scenarioId !== 'string' || !e.scenarioId) return null;
    const repeat = (e.repeat === 'once') ? 'once' : 'daily';
    let maxJitterMin = Number(e.maxJitterMin);
    if (!Number.isFinite(maxJitterMin) || maxJitterMin < 0) maxJitterMin = 0;
    maxJitterMin = Math.min(Math.floor(maxJitterMin), 720); // cap at 12h of jitter
    return {
        id: e.id,
        time: e.time,
        scenarioId: e.scenarioId,
        repeat,
        maxJitterMin,
        enabled: e.enabled !== false, // default true
    };
}

function sanitizeSchedule(raw) {
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const events = Array.isArray(obj.events) ? obj.events.map(sanitizeEvent).filter(Boolean) : [];
    const scheduleActive = obj.scheduleActive === true;
    let tzOffsetMin = Number(obj.tzOffsetMin);
    if (!Number.isFinite(tzOffsetMin) || tzOffsetMin < -840 || tzOffsetMin > 840) tzOffsetMin = 0;
    return { events, scheduleActive, tzOffsetMin };
}

function readJsonFile(path, fallback, label) {
    let raw;
    try {
        raw = fs.readFileSync(path, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') log.warn({ path, err: err.message }, label + ' unreadable, using empty');
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        log.warn({ path, err: err.message }, label + ' corrupt, using empty');
        return fallback;
    }
}

function writeJsonAtomic(path, value, label) {
    const tmp = path + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
        fs.renameSync(tmp, path);
    } catch (err) {
        log.warn({ path, err: err.message }, label + ' persist failed');
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        throw err;
    }
}

// ---- schedule (UI-owned) ----
function readSchedule() {
    return sanitizeSchedule(readJsonFile(SCHEDULE_PATH, {}, 'schedule'));
}

function saveSchedule(schedule) {
    const clean = sanitizeSchedule(schedule);
    writeJsonAtomic(SCHEDULE_PATH, clean, 'schedule');
    return clean;
}

// ---- daemon state (fired-tracking, daemon-owned) ----
function readState() {
    const obj = readJsonFile(STATE_PATH, {}, 'schedule-state');
    const fired = (obj && typeof obj.fired === 'object' && obj.fired) ? obj.fired : {};
    return { fired };
}

function writeState(state) {
    writeJsonAtomic(STATE_PATH, { fired: state.fired || {} }, 'schedule-state');
}

module.exports = {
    readSchedule, saveSchedule,
    readState, writeState,
    sanitizeSchedule, sanitizeEvent,
    SCHEDULE_PATH, STATE_PATH, TIME_RE,
};
