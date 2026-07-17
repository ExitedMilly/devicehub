'use strict';

// Nearest real LTE cell tower to a GPS coordinate, from the OpenCelliD MCC-250
// dump loaded into SQLite (see opencellid-data/build_db.py). Feeds the GPS→cell
// sync (Step 3): coordinates -> this -> persist.vendor.orchid.ril.* -> RIL.
//
// LTE ONLY: a modern phone must not be handed a GSM/UMTS cell, so the query and
// the DB's partial index are both restricted to radio='LTE' (82k of the 111k rows).
// GOTCHA the dump is easy to get wrong: column order is lon BEFORE lat.
//
// The DB is read-only and bind-mounted (CELL_GEO_DB). better-sqlite3 ships a
// prebuilt binary for linux glibc node18, so no native build is needed — but the
// manager image must add it as a dependency for the sync to run there.

const log = require('../log').getLogger('domain/cell-geo');

let Database = null;
try {
    Database = require('better-sqlite3');
} catch (err) {
    log.warn({ err: err.message }, 'better-sqlite3 not installed; cell-geo lookups disabled');
}

const DB_PATH = process.env.CELL_GEO_DB || '/opencellid/towers.db';
// Grow the bbox until at least one LTE tower is found. Urban boxes hit on the
// first step; the wide steps cover rural gaps without scanning the whole country.
const RADIUS_STEPS_KM = [2, 5, 10, 25, 60];

let db = null;

function ready() {
    return Database !== null;
}

function ensureDb() {
    if (db) return db;
    if (!Database) throw new Error('better-sqlite3 not installed; cannot query tower DB');
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Nearest LTE tower to (lat, lon). opts.mnc restricts to one operator's towers,
// so a synced serving cell can belong to the INSTANCE's operator rather than
// whatever tower happens to be closest (the cell identity is bound to the SIM
// operator by domain/cell-tower.js). Returns the RIL-property fields plus the
// tower position/distance for logging, or null when nothing is within ~60km.
function nearestLteTower(lat, lon, opts = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('nearestLteTower needs finite lat/lon');
    }
    ensureDb();
    const mnc = (opts.mnc !== undefined && opts.mnc !== null && opts.mnc !== '')
        ? parseInt(opts.mnc, 10)
        : null;

    const sql = 'SELECT cell, area, mcc, net, unit, lat, lon FROM towers ' +
        "WHERE radio='LTE' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?" +
        (mnc !== null ? ' AND net=?' : '');
    const query = db.prepare(sql);

    for (const rKm of RADIUS_STEPS_KM) {
        const dLat = rKm / 111.0;
        const dLon = rKm / (111.0 * Math.cos((lat * Math.PI) / 180));
        const args = [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
        if (mnc !== null) args.push(mnc);
        const rows = query.all(...args);
        if (!rows.length) continue;

        let best = null;
        let bestD = Infinity;
        for (const r of rows) {
            const d = haversineM(lat, lon, r.lat, r.lon);
            if (d < bestD) { bestD = d; best = r; }
        }
        return {
            cid: best.cell,
            lac: best.area,   // OpenCelliD 'area' is TAC for LTE; cell-tower.js maps lac/tac from it
            tac: best.area,
            mcc: best.mcc,
            mnc: best.net,
            rat: 'lte',
            // context (not spoofed): tower position, distance, and the search that hit
            towerLat: best.lat,
            towerLon: best.lon,
            distanceM: Math.round(bestD),
            candidates: rows.length,
            radiusKm: rKm,
        };
    }
    return null;
}

module.exports = { nearestLteTower, haversineM, ready, DB_PATH };
