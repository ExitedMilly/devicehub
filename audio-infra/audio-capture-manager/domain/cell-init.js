'use strict';

// Applies a per-instance INITIAL serving cell after boot, so a fresh op-v4 device
// starts on a configured tower instead of the emulator's stock cell. Just a
// starting value — the user can override it from the UI (their apply supersedes
// this). Operator is not part of the cell config: applyCellTower pins MCC/MNC to
// the SIM the op-shim already baked, so the initial cell is automatically
// consistent with the instance's operator. Fire-and-forget with a boot-wait retry
// loop, mirroring domain/gps-init.js — the manager starts before the emulator has
// booted, and the SIM operator is not readable until it has.

const { applyCellTower } = require('./cell-tower');
const log = require('../log').getLogger('domain/cell-init');

const RETRY_MS = 4000;
const MAX_ATTEMPTS = 75; // ~5 min, covers a slow cold boot

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop(serial, cell) {
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        try {
            await applyCellTower(serial, cell);
            log.info({ serial, cell, attempt: n }, 'initial cell applied');
            return;
        } catch (err) {
            log.info({ serial, attempt: n, err: err.message }, 'initial cell: device may still be booting, retrying');
            await sleep(RETRY_MS);
        }
    }
    log.warn({ serial, cell }, 'initial cell: gave up after max attempts');
}

// Fire-and-forget. No-op unless a cell is configured (cid+lac+rat required).
function start(serial, cell) {
    if (!cell || cell.cid == null || cell.lac == null || !cell.rat) return;
    log.info({ serial, cell }, 'scheduling initial cell');
    void loop(serial, cell);
}

module.exports = { start };
