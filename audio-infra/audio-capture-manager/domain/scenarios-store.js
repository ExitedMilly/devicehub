'use strict';

// Per-device persistent store for user-built constructor scenarios (Type 1) — the
// single source of truth shared by the UI (over HTTP) and, later, the Type-2 schedule
// daemon. Lives on the /backups host bind-mount so it survives manager restart AND
// container recreation. Definition format is unchanged from the old localStorage blob:
//   [ { id: string, name: string, params: [ { type: string, value: any } ] } ]

const fs = require('fs');
const log = require('../log').getLogger('domain/scenarios-store');

const SCENARIOS_PATH = process.env.SCENARIOS_PATH || '/backups/scenarios.json';

// Drop anything that isn't a well-formed scenario so a hand-edited or partially-written
// file can never crash a reader (the same defensiveness the frontend sanitize() had).
function sanitize(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const s of raw) {
        if (!s || typeof s !== 'object') continue;
        if (typeof s.id !== 'string' || typeof s.name !== 'string' || !Array.isArray(s.params)) continue;
        const params = s.params.filter(
            (p) => p && typeof p === 'object' && typeof p.type === 'string' && Object.prototype.hasOwnProperty.call(p, 'value')
        ).map((p) => ({ type: p.type, value: p.value }));
        out.push({ id: s.id, name: s.name, params });
    }
    return out;
}

// Read the whole set. Missing file = empty (normal first run, silent). Unreadable or
// corrupt file = empty + a warning; never throws, never crashes the daemon/route.
function readAll() {
    let raw;
    try {
        raw = fs.readFileSync(SCENARIOS_PATH, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            log.warn({ path: SCENARIOS_PATH, err: err.message }, 'scenarios file unreadable, treating as empty');
        }
        return [];
    }
    try {
        return sanitize(JSON.parse(raw));
    } catch (err) {
        log.warn({ path: SCENARIOS_PATH, err: err.message }, 'scenarios file corrupt, treating as empty');
        return [];
    }
}

// Atomically replace the whole set (write tmp + rename; unlink tmp on failure) — same
// pattern as walk-simulator.js persistRouteCache, so a reader never sees a half file.
function writeAll(scenarios) {
    const clean = sanitize(scenarios);
    const tmp = SCENARIOS_PATH + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(clean), 'utf8');
        fs.renameSync(tmp, SCENARIOS_PATH);
    } catch (err) {
        log.warn({ path: SCENARIOS_PATH, err: err.message }, 'scenarios persist failed');
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        throw err; // surface to the route so the UI learns the save failed
    }
    return clean;
}

// ---- CRUD ----
function list() {
    return readAll();
}

function get(id) {
    return readAll().find((s) => s.id === id) || null;
}

// Replace the entire set (the UI owns the array and PUTs it whole — simplest, and it
// keeps ids stable). Returns the sanitized set actually written.
function saveAll(scenarios) {
    return writeAll(scenarios);
}

// Per-item helpers (not used by the whole-set route, but handy for the daemon/tests).
function upsert(scenario) {
    const all = readAll();
    const i = all.findIndex((s) => s.id === scenario.id);
    if (i >= 0) all[i] = scenario; else all.push(scenario);
    return writeAll(all);
}

function remove(id) {
    return writeAll(readAll().filter((s) => s.id !== id));
}

module.exports = { list, get, saveAll, upsert, remove, sanitize, SCENARIOS_PATH };
