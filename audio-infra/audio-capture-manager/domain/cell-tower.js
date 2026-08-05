'use strict';

// Runtime serving-cell / neighbour spoofing. The baked libcuttlefish-ril-2.so (op-v4
// and newer) reads cell identity from persist.vendor.orchid.ril.* properties (unset =>
// stock behaviour). We set them from the plain shell and then restart the RIL daemon so
// the framework re-acquires the serving cell.
//
// REQUIRES op-v6 OR NEWER. Those properties used to fall through to vendor_default_prop,
// which platform policy lets only init/vendor_init set, so writing them needed `adb root`.
// A root adbd stops minicap from starting at all, which killed the device screen stream —
// this operblock and the screen could not be used at the same time. op-v6 gives the
// namespace its own SELinux type (orchid_ril_prop) that the shell domain may set, so no
// root is taken here any more and adbd stays in shell mode.
//
// On op-v5 and older there is no such label: setprop from the shell silently no-ops and
// this module cannot work. Those instances need op-v6 (fleet migration is separate).
//
// WHY A DAEMON RESTART (not just re-registration): the RIL re-reads the props on
// every registration query, but the framework CACHES ServiceState.mCellIdentity and
// does NOT refresh it from a plain gsm re-registration (verified: parseRegistrationState
// fires but the serving cell stays put). Restarting vendor.ril-daemon forces a full
// re-acquire, and the framework then takes the new serving cell. ~6s, telephony
// survives the radio blip. See restartRil().
//
// SERVING vs NEIGHBOURS: the serving cell (cid/lac/tac/rat) updates on the daemon
// restart. The neighbour list (getCellInfoList) is cached harder by the framework
// and refreshes ONLY on a full reboot — so neighbours set here apply on the next
// reboot, not live. The UI states this.
//
// Operator is BOUND TO THE INSTANCE. The op-shim bakes the operator NAME
// (numeric_operator.xml) and SIM IMSI at container creation and there is no
// runtime path to change the name — only the RIL numeric code can move. So a
// live operator switch would show the new code under the old name ("MTS name +
// Beeline code"). To make that divergence impossible, this module pins the RIL
// MCC/MNC to whatever the guest SIM already reports (gsm.sim.operator.numeric):
// the caller may not choose a different operator. To change operator, recreate
// the instance with a new op_* (see scripts/generate.py). Cell fields
// (cid/lac/tac/rat/neighbors) are freely editable.

const { runAdb } = require('../adb-runner');
const operators = require('./operators');
const log = require('../log').getLogger('domain/cell-tower');

const PROP_PREFIX = 'persist.vendor.orchid.ril.';
const MAX_NEIGHBORS = 8; // must match ORCHID_MAX_NEIGHBORS in reference-ril.c

// UI-facing RAT tokens -> RADIO_TECH_* ints the RIL patch expects.
const RAT_MAP = { gsm: 16, umts: 11, lte: 14, nr: 20 };

// The full set of props this module owns, so reset clears exactly these.
const OWNED_PROPS = ['cid', 'lac', 'tac', 'mcc', 'mnc', 'mnclen', 'rat', 'neighbors'];

// ----- Validators -----

function validateInt(value, min, max, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
    }
    return n;
}

function validateRat(rat) {
    const key = String(rat == null ? '' : rat).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(RAT_MAP, key)) {
        throw new Error('rat must be one of: ' + Object.keys(RAT_MAP).join(', '));
    }
    return key;
}

// "cid:lac:rssi,cid:lac:rssi" -> canonical, validated string (or '' for none).
// A bad triplet is a hard error rather than a silent drop, so the user sees it.
function validateNeighbors(neighbors) {
    const raw = String(neighbors == null ? '' : neighbors).trim();
    if (!raw) return '';
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > MAX_NEIGHBORS) {
        throw new Error('at most ' + MAX_NEIGHBORS + ' neighbors are supported');
    }
    const out = [];
    for (const part of parts) {
        const m = part.split(':');
        if (m.length !== 3) {
            throw new Error('neighbor "' + part + '" must be cid:lac:rssi');
        }
        const cid = validateInt(m[0], 0, 268435455, 'neighbor cid');
        const lac = validateInt(m[1], 0, 65535, 'neighbor lac');
        const rssi = validateInt(m[2], 0, 31, 'neighbor rssi (asu 0..31)');
        out.push(cid + ':' + lac + ':' + rssi);
    }
    return out.join(',');
}

// ----- Guest I/O helpers -----

// No root, and deliberately no `su 0` either: on op-v6 these properties carry the
// orchid_ril_prop type, which the shell domain is allowed to set outright (verified on a
// live device under SELinux Enforcing). Keeping this on the plain shell is the whole
// point — taking root would restart adbd as root and stop minicap, killing the screen.
function setProp(serial, key, value) {
    // adb flattens argv to a shell string, which drops a trailing EMPTY arg — so
    // `setprop KEY ''` via separate argv errors "usage: setprop NAME VALUE" and
    // fails to clear. Pass a single quoted command so the device shell sees an
    // explicit "" for clears and a quoted value for sets. Values are pre-validated
    // (ints / enum / cid:lac:rssi), so they contain no quote to break out with.
    return runAdb(serial, ['shell', `setprop ${PROP_PREFIX}${key} "${String(value)}"`]);
}

async function getProp(serial, key) {
    const res = await runAdb(serial, ['shell', 'getprop', PROP_PREFIX + key], { allowFailure: true });
    return (res.stdout || '').trim();
}

// The operator the instance was born with — the ground truth we pin RIL to.
// gsm.sim.operator.numeric is the PLMN the op-shim baked into the SIM.
async function getSimOperator(serial) {
    const numeric = (await runAdb(serial, ['shell', 'getprop', 'gsm.sim.operator.numeric'], { allowFailure: true })).stdout.trim();
    const alpha = (await runAdb(serial, ['shell', 'getprop', 'gsm.sim.operator.alpha'], { allowFailure: true })).stdout.trim();
    if (!/^\d{5,6}$/.test(numeric)) {
        return { ready: false, plmn: numeric || null, mcc: null, mnc: null, mncLen: null, name: alpha || null };
    }
    const mcc = numeric.slice(0, 3);
    const mnc = numeric.slice(3);
    const known = operators.byPlmn(mcc, mnc);
    return {
        ready: true,
        plmn: numeric,
        mcc,
        mnc,
        mncLen: mnc.length,
        // Prefer the canonical table name, fall back to the SIM's own alpha, then the PLMN.
        name: (known && known.name) || alpha || numeric,
    };
}

// Make the framework pick up the new property values. The RIL re-reads the props
// on every registration query, but the framework CACHES ServiceState.mCellIdentity
// and will NOT refresh it from a plain gsm re-registration — so we restart the RIL
// daemon, which forces a full re-acquire: rild re-runs RIL_Init, re-queries, and
// the framework takes the fresh serving cell. ~6s, telephony survives the blip.
// The service is `vendor.ril-daemon` (NOT `rild`; that name has no matching service
// and its ctl.restart is rejected).
//
// This one step DOES need elevation, but only `su 0`, never `adb root`. ctl.restart is a
// ctl_* property, a separate family that the orchid_ril_prop label does not cover, and the
// shell domain has no allow for it (verified: plain `setprop ctl.restart` fails with
// "Failed to set property"). `su 0` runs the single command as root without touching
// adbd's own mode, so minicap and the screen stream stay up — which `adb root` would not.
//
// NOTE: this refreshes the SERVING cell only; the neighbour list (getCellInfoList)
// is cached harder by the framework and updates only on a full reboot.
const RIL_SERVICE = 'vendor.ril-daemon';
const RIL_RESTART_SETTLE_MS = 7000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restartRil(serial) {
    await runAdb(serial, ['shell', `su 0 setprop ctl.restart ${RIL_SERVICE}`]);
    // Give init time to respawn the daemon and the radio to re-register.
    await sleep(RIL_RESTART_SETTLE_MS);
}

// ----- Public API -----

// Read back what is currently spoofed plus the pinned operator and the live
// serving cell as the framework sees it.
async function getCellTowerStatus(serial) {
    const props = {};
    for (const k of OWNED_PROPS) {
        props[k] = await getProp(serial, k);
    }
    const sim = await getSimOperator(serial);
    const applied = ['cid', 'lac', 'tac', 'rat', 'neighbors'].some((k) => props[k] !== '');

    // Best-effort read of the live serving cell (does not fail the call).
    let serving = null;
    try {
        const dump = (await runAdb(serial, ['shell', 'dumpsys', 'telephony.registry'], { allowFailure: true, timeoutMs: 8000 })).stdout;
        const cid = dump.match(/mC(?:i|id)=(\d+)/);
        const lac = dump.match(/m(?:Lac|Tac)=(\d+)/);
        const type = dump.match(/CellIdentity([A-Za-z]+)/);
        serving = {
            cid: cid ? Number(cid[1]) : null,
            lac: lac ? Number(lac[1]) : null,
            type: type ? type[1] : null,
        };
    } catch (err) {
        log.warn({ serial, err: err.message }, 'getCellTowerStatus: dumpsys read failed');
    }

    return {
        applied,
        cid: props.cid || null,
        lac: props.lac || null,
        tac: props.tac || null,
        rat: props.rat || null,
        neighbors: props.neighbors || null,
        operator: { mcc: sim.mcc, mnc: sim.mnc, name: sim.name, plmn: sim.plmn, locked: true },
        serving,
    };
}

async function applyCellTower(serial, body = {}) {
    const cid = validateInt(body.cid, 0, 268435455, 'cid');
    const lac = validateInt(body.lac, 0, 65535, 'lac');
    const tac = body.tac === undefined || body.tac === null || body.tac === ''
        ? lac
        : validateInt(body.tac, 0, 65535, 'tac');
    const ratKey = validateRat(body.rat);
    const neighbors = validateNeighbors(body.neighbors);

    const sim = await getSimOperator(serial);
    if (!sim.ready) {
        throw new Error('SIM operator not ready yet (device may still be booting); cannot pin operator');
    }

    // Operator is bound to the instance: if the caller supplied MCC/MNC, they
    // must match the baked SIM operator — otherwise we would produce the exact
    // "old name + new code" divergence this design forbids.
    if (body.mcc !== undefined && body.mcc !== null && body.mcc !== '') {
        const wantMcc = String(body.mcc);
        const wantMnc = parseInt(body.mnc, 10);
        if (wantMcc !== sim.mcc || wantMnc !== parseInt(sim.mnc, 10)) {
            throw new Error(
                'operator is bound to this instance (' + sim.name + ' ' + sim.plmn + '); ' +
                'to change it, recreate the instance with a different op_*'
            );
        }
    }

    log.info({ serial, cid, lac, tac, rat: ratKey, plmn: sim.plmn, neighbors: neighbors || '(none)' }, 'Applying cell tower');

    // Pin the numeric operator to the SIM. mnc is stored without a leading zero
    // (the RIL parses it as an int); mnclen carries the digit count so the RIL
    // re-pads it for the PLMN string. This keeps gsm.operator.numeric equal to
    // gsm.sim.operator.numeric, so the name never diverges from the code.
    await setProp(serial, 'mcc', sim.mcc);
    await setProp(serial, 'mnc', String(parseInt(sim.mnc, 10)));
    await setProp(serial, 'mnclen', String(sim.mncLen));

    await setProp(serial, 'cid', cid);
    await setProp(serial, 'lac', lac);
    await setProp(serial, 'tac', tac);
    await setProp(serial, 'rat', RAT_MAP[ratKey]);
    // Always write neighbors (empty clears a previous list) so apply is deterministic.
    await setProp(serial, 'neighbors', neighbors);

    // Restart the RIL daemon so the framework re-acquires the serving cell (~6s).
    // Neighbours in the list won't refresh until a full reboot — the UI says so.
    await restartRil(serial);
    return getCellTowerStatus(serial);
}

async function resetCellTower(serial) {
    log.info({ serial }, 'Resetting cell tower to stock');
    for (const k of OWNED_PROPS) {
        await setProp(serial, k, '');
    }
    await restartRil(serial);
    return getCellTowerStatus(serial);
}

module.exports = {
    applyCellTower,
    resetCellTower,
    getCellTowerStatus,
    getSimOperator,
    // exported for tests
    validateNeighbors,
    validateRat,
    RAT_MAP,
};
