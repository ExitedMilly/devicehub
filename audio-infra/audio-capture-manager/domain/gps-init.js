'use strict';

// Applies a per-instance INITIAL GPS location after boot so a fresh device shows it
// instead of the emulator's Googleplex default (37.422,-122.084). Uses the same GPS
// mock keepalive as the UI (startGpsKeepAlive), so it persists in the empty state and
// the user can override it later from the UI — their apply calls startGpsKeepAlive too,
// which stops this keepalive first, so the initial value NEVER blocks a later change.
// (geo fix is not used: a test-provider mock overrides the emulator's hardware GNSS, so
// geo fix has no effect once any mock is active.) Fire-and-forget with a boot-wait retry
// loop — the manager starts before the emulator has finished booting.

const { startGpsKeepAlive } = require('./gps');
const log = require('../log').getLogger('domain/gps-init');

const RETRY_MS = 4000;
const MAX_ATTEMPTS = 75; // ~5 min, covers a slow cold boot

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop(serial, lat, lon) {
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        try {
            await startGpsKeepAlive(serial, lat, lon, 'gps');
            log.info({ serial, lat, lon, attempt: n }, 'initial GPS location applied');
            return;
        } catch (err) {
            log.info({ serial, attempt: n, err: err.message }, 'initial GPS: device may still be booting, retrying');
            await sleep(RETRY_MS);
        }
    }
    log.warn({ serial, lat, lon }, 'initial GPS: gave up after max attempts');
}

// Fire-and-forget. No-op unless both coordinates are finite numbers (empty => the
// emulator's default location stays).
function start(serial, lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    log.info({ serial, lat, lon }, 'scheduling initial GPS location');
    void loop(serial, lat, lon);
}

module.exports = { start };
