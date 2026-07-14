'use strict';

// Type-2 schedule daemon. A per-manager (SINGLE_MODE) minute-tick that applies saved
// scenarios at their scheduled local time, autonomously — no browser needed. It REUSES
// scenario-apply.applyScenario (the same backend apply path as the instant Type-1 UI),
// re-reads the schedule + scenarios files every tick (so a manager restart self-heals
// and file edits are picked up), and derives "due" from the wall clock in the user's
// timezone (the container runs UTC; the schedule carries the browser's tzOffsetMin).

const scheduleStore = require('./schedule-store');
const scenariosStore = require('./scenarios-store');
const { applyScenario } = require('./scenario-apply');
const log = require('../log').getLogger('domain/scheduler');

const TICK_MS = 60 * 1000;          // ~60s minute tick
const FIRE_WINDOW_MIN = 5;          // fire when now is within [effective, effective+5min)
                                    // so a brief downtime / tick granularity still catches
                                    // it, but a just-created past-due event isn't fired hours late.

let timer = null;
let applying = false;               // re-entrancy guard (SINGLE_MODE = one serial)

function parseHHMM(time) {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

// "Now" expressed in the schedule's timezone offset (minutes east of UTC). Reading the
// UTC fields of (utcNow + offset) yields the local wall clock in that offset — correct
// regardless of the container's own TZ.
function nowInOffset(tzOffsetMin) {
    const d = new Date(Date.now() + (Number(tzOffsetMin) || 0) * 60000);
    const dateKey = d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0');
    return { dateKey, minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// Deterministic per-(event,day) jitter in [0, maxJitterMin]. Stable within a day (so the
// due check is consistent across ticks and survives restart) and different each day —
// no persistence, no Math.random.
function jitterMinutes(id, dateKey, maxJitterMin) {
    const max = Math.max(0, Math.floor(Number(maxJitterMin) || 0));
    if (max === 0) return 0;
    let h = 2166136261;
    const s = id + '|' + dateKey;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % (max + 1);
}

// Should this event fire right now? Encapsulates the effective-time (base + jitter),
// the firing window, and the anti-repeat rule (daily = once per day; once = ever).
function isDue(event, now, fired) {
    const base = parseHHMM(event.time);
    if (base == null) return false;
    const last = fired[event.id];
    if (event.repeat === 'once') {
        if (last != null) return false;                 // once: fired ever -> never again
    } else if (last === now.dateKey) {
        return false;                                   // daily: already fired today
    }
    let effective = base + jitterMinutes(event.id, now.dateKey, event.maxJitterMin);
    // Clamp so late+jitter can't wrap past midnight, leaving a FULL window before 24:00
    // (clamping to 1439 would collapse the tolerance to a single minute near midnight).
    if (effective > 1440 - FIRE_WINDOW_MIN) effective = 1440 - FIRE_WINDOW_MIN;
    return now.minutesOfDay >= effective && now.minutesOfDay < effective + FIRE_WINDOW_MIN;
}

async function tick(serial) {
    if (applying) {
        log.info({ serial }, 'scheduler tick skipped — previous apply still running');
        return;
    }

    const { events, scheduleActive, tzOffsetMin } = scheduleStore.readSchedule();
    const state = scheduleStore.readState();

    // Prune fired-state for events that no longer exist (so delete+recreate re-arms).
    const liveIds = new Set(events.map((e) => e.id));
    let statePruned = false;
    for (const id of Object.keys(state.fired)) {
        if (!liveIds.has(id)) { delete state.fired[id]; statePruned = true; }
    }

    if (!scheduleActive) {
        if (statePruned) { try { scheduleStore.writeState(state); } catch (e) { /* best-effort */ } }
        return;
    }

    const now = nowInOffset(tzOffsetMin);
    const due = events.filter((e) => e.enabled && isDue(e, now, state.fired));

    if (due.length === 0) {
        if (statePruned) { try { scheduleStore.writeState(state); } catch (e) { /* best-effort */ } }
        return;
    }

    applying = true;
    try {
        for (const event of due) {
            const scenario = scenariosStore.get(event.scenarioId);
            if (!scenario) {
                log.warn({ serial, eventId: event.id, scenarioId: event.scenarioId }, 'scheduled scenario not found — skipping');
                // Mark fired anyway so a dangling event doesn't retry every tick today.
                state.fired[event.id] = now.dateKey;
                continue;
            }
            // Mark fired BEFORE applying: a restart mid-apply must NOT re-fire today
            // (interruption is acceptable per design). If the mark can't be persisted
            // (read-only / full /backups), DO NOT apply — the mark is re-read from disk
            // each tick with no in-memory fallback, so applying anyway would re-fire every
            // 60s across the window. Fail-safe (skip) beats fail-repeat.
            state.fired[event.id] = now.dateKey;
            try {
                scheduleStore.writeState(state);
            } catch (e) {
                log.error({ serial, eventId: event.id, err: e && e.message }, 'cannot persist fired mark — skipping apply to avoid re-fire');
                delete state.fired[event.id];
                continue;
            }

            log.info({ serial, eventId: event.id, scenario: scenario.name, time: event.time, repeat: event.repeat }, 'scheduler firing scenario');
            try {
                const result = await applyScenario(serial, scenario.params);
                log.info({ serial, eventId: event.id, applied: result.applied, failures: result.failures }, 'scheduler applied scenario');
            } catch (err) {
                log.error({ serial, eventId: event.id, err: err && err.message }, 'scheduler apply threw (continuing)');
            }
        }
        try { scheduleStore.writeState(state); } catch (e) { /* best-effort */ }
    } finally {
        applying = false;
    }
}

function start(serial) {
    stop();
    log.info({ serial, tickMs: TICK_MS }, 'scheduler daemon started');
    // Run one tick right away so an event whose window falls in the first 60s after a
    // manager (re)start still fires today — otherwise it would be missed until the first
    // interval tick. Anti-repeat state persists on /backups, so this can't double-fire.
    void tick(serial);
    timer = setInterval(() => { void tick(serial); }, TICK_MS);
}

function stop() {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}

module.exports = { start, stop, tick, isDue, jitterMinutes, nowInOffset, parseHHMM, FIRE_WINDOW_MIN };
