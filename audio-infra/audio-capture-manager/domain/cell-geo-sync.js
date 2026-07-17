'use strict';

// Bridges a GPS coordinate to the serving cell: nearest real LTE tower OF THE
// INSTANCE'S OPERATOR -> applyCellTower. Stateless apply-once, exactly like
// domain/weather.js and domain/wifi-geo.js — the enable/throttle/walk-tracking
// lives in the frontend store (device-scenarios-store.ts), which POSTs here only
// on significant movement (a RIL restart per apply is ~7s, so the throttle is km-scale).
//
// Operator is baked/pinned per instance (Stage 6). We read it from the SIM and
// pass its MNC to nearestLteTower, so the tower belongs to the RIGHT carrier —
// a tower of another operator under this SIM would be an obvious mismatch.

const { nearestLteTower, ready: geoReady } = require('./cell-geo');
const { applyCellTower, getSimOperator, getCellTowerStatus } = require('./cell-tower');
const log = require('../log').getLogger('domain/cell-geo-sync');

async function applyCellSync(serial, latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('latitude/longitude must be finite numbers');
    }
    if (!geoReady()) {
        throw new Error('tower DB unavailable (better-sqlite3 or towers.db missing)');
    }

    const sim = await getSimOperator(serial);
    if (!sim.ready) {
        throw new Error('SIM operator not ready (device may still be booting)');
    }

    const tower = nearestLteTower(lat, lon, { mnc: sim.mnc });
    if (!tower) {
        log.info({ serial, lat, lon, mnc: sim.mnc }, 'no LTE tower of this operator near location');
        return { ok: true, changed: false, reason: 'no tower found near location', operator: sim.name };
    }

    // Skip the ~7s RIL restart when the nearest tower is the one already applied —
    // during a walk many throttled POSTs still resolve to the same serving cell.
    const status = await getCellTowerStatus(serial);
    if (status.cid != null && String(status.cid) === String(tower.cid)) {
        return {
            ok: true, changed: false, reason: 'already on nearest tower',
            cid: tower.cid, distanceM: tower.distanceM, operator: sim.name,
        };
    }

    log.info({ serial, lat, lon, cid: tower.cid, distanceM: tower.distanceM, operator: sim.name },
        'syncing serving cell to nearest LTE tower');

    // applyCellTower re-reads the SIM and pins mcc/mnc; the tower already carries
    // this operator's mnc (filter), so the pin matches and it is not rejected.
    const applied = await applyCellTower(serial, {
        cid: tower.cid, lac: tower.lac, tac: tower.tac,
        mcc: tower.mcc, mnc: tower.mnc, rat: tower.rat,
    });

    return {
        ok: true, changed: true,
        cid: tower.cid, distanceM: tower.distanceM,
        towerLat: tower.towerLat, towerLon: tower.towerLon,
        operator: sim.name, serving: applied.serving,
    };
}

module.exports = { applyCellSync };
