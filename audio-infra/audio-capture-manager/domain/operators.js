'use strict';

// Read-only accessors over the canonical operator table (operators.json).
// The table maps an operator id (e.g. "mts") to { mcc, mnc, name, nameShort }.
// It is the shared source of truth so the op-shim NAME and the RIL numeric
// MCC/MNC always come from the same row — see operators.json for why.

const fs = require('fs');
const path = require('path');
const log = require('../log').getLogger('domain/operators');

let TABLE = {};
try {
    const raw = fs.readFileSync(path.join(__dirname, 'operators.json'), 'utf8');
    TABLE = JSON.parse(raw).operators || {};
} catch (err) {
    log.warn({ err: err.message }, 'operators.json unreadable; operator names will fall back to PLMN');
}

// mnc "01" -> mncLen 2. Kept as a helper so callers never recompute it.
function mncLen(mnc) {
    return String(mnc == null ? '' : mnc).length;
}

function byId(id) {
    const row = TABLE[id];
    if (!row) return null;
    return { id, mcc: row.mcc, mnc: row.mnc, name: row.name, nameShort: row.nameShort, mncLen: mncLen(row.mnc) };
}

// Look up an operator by its numeric identity. mnc is matched both as the raw
// stored string ("01") and numerically (1), so callers can pass either form.
function byPlmn(mcc, mnc) {
    const wantMcc = String(mcc);
    const wantMncNum = parseInt(mnc, 10);
    for (const id of Object.keys(TABLE)) {
        const row = TABLE[id];
        if (row.mcc === wantMcc && parseInt(row.mnc, 10) === wantMncNum) {
            return { id, mcc: row.mcc, mnc: row.mnc, name: row.name, nameShort: row.nameShort, mncLen: mncLen(row.mnc) };
        }
    }
    return null;
}

function list() {
    return Object.keys(TABLE).map(byId);
}

module.exports = { byId, byPlmn, list, mncLen };
