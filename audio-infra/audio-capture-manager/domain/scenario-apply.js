'use strict';

// Applies a constructor scenario ({ params: [{ type, value }] }) by calling the
// operblock DOMAIN functions directly (no HTTP, no auth) — the same functions the
// HTTP routes wrap. This is the single apply path for BOTH the instant Type-1 UI
// (frontend POSTs here instead of driving stores) and the upcoming Type-2 schedule
// daemon (which will require() and call applyScenario directly).
//
// Four things that used to live in the frontend are ported here:
//  1. signal strong/weak -> signalProfile 4/0            (device-network-store:140)
//  2. pose preset NAME -> {pitch,yaw,roll} angles         (device-constructor-store POSE_PRESETS)
//  3. sensor-noise `owned` computed from the scenario's other sensor params
//  4. weather/bssid LOCATION: the scenario's gps.location, else the active keepalive
//     session — GPS is applied FIRST so those reads see the just-set location.

const battery = require('./battery');
const network = require('./network');
const gps = require('./gps');
const temperature = require('./temperature');
const light = require('./light');
const pose = require('./pose');
const sensorNoise = require('./sensor-noise');
const bluetooth = require('./bluetooth');
const proxy = require('./proxy');
const phonenumber = require('./phonenumber');
const weather = require('./weather');
const wifiGeo = require('./wifi-geo');
const { gpsSessions } = require('../stores');
const log = require('../log').getLogger('domain/scenario-apply');

// Pose preset -> angles, ported verbatim from the frontend PARAM catalog.
const POSE_PRESETS = {
    flat:      { pitch: 0,   yaw: 0, roll: 0 },
    rightTilt: { pitch: 0,   yaw: 0, roll: 90 },
    leftTilt:  { pitch: 0,   yaw: 0, roll: -90 },
    topDown:   { pitch: 90,  yaw: 0, roll: 0 },
    bottomUp:  { pitch: -90, yaw: 0, roll: 0 },
};

// Sensor-noise resource keys each param drives (must match sensor-noise.js
// RESOURCE_SENSORS: light | pose | temperature | humidity | pressure). Noise must
// YIELD these so the scenario's explicit values hold instead of being jittered.
const NOISE_OWN = {
    'light.lux': ['light'],
    'pose.preset': ['pose'],
    'temperature.value': ['temperature'],
    'weather.on': ['temperature', 'humidity', 'pressure'],
};

const STEP_DELAY_MS = 150; // same inter-step spacing the built-in presets use

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the location for weather/bssid: the scenario's own gps.location (preferred —
// it is applied first this run), else the currently-active GPS keepalive session.
function resolveLocation(serial, byType) {
    if (byType.has('gps.location')) {
        const v = byType.get('gps.location') || {};
        const lat = Number(v.lat);
        const lon = Number(v.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
    const sess = gpsSessions.get(serial);
    if (sess && Number.isFinite(sess.latitude) && Number.isFinite(sess.longitude)) {
        return { lat: sess.latitude, lon: sess.longitude };
    }
    return null;
}

/**
 * Apply a scenario's params to `serial`. Never throws; returns
 *   { ok, applied: [type...], failures: [{ type, error }] }
 * so the caller (route or daemon) can report per-param outcomes.
 */
async function applyScenario(serial, params) {
    const list = Array.isArray(params) ? params : [];
    const byType = new Map(list.map((p) => [p.type, p.value]));
    const failures = [];
    const applied = [];

    // Sensors this scenario sets, which running noise must yield (skip-first).
    const sceneNoiseOwn = [...new Set(list.flatMap((p) => NOISE_OWN[p.type] || []))];

    const steps = []; // { type, run }

    // ---- 1) GPS FIRST (weather/bssid read the location it sets) ----
    if (byType.has('gps.location')) {
        const v = byType.get('gps.location') || {};
        steps.push({ type: 'gps.location', run: () => gps.startGpsKeepAlive(serial, v.lat, v.lon, 'gps') });
    }

    // ---- 2) Sensor-noise coordination BEFORE writing sensor values (skip-first) ----
    // If the scenario turns noise on/off, do it now with the computed owned set. If
    // noise is already running (manual toggle or a prior scenario), extend its owned
    // set so this scenario's sensor values are yielded and won't be jittered away.
    if (byType.has('sensors.noise')) {
        if (byType.get('sensors.noise') === true) {
            // If noise is already running (an ambient/operblock or a prior scenario owns
            // some sensors), MERGE this scenario's owned set in rather than start() —
            // start() would replace `owned` and un-yield the other owner's sensors,
            // letting noise jitter values it should be holding.
            steps.push({ type: 'sensors.noise', run: () => {
                if (sensorNoise.isRunning(serial)) {
                    const cur = (sensorNoise.getStatus(serial).owned) || [];
                    sensorNoise.setOwned(serial, [...new Set([...cur, ...sceneNoiseOwn])]);
                } else {
                    sensorNoise.start(serial, sceneNoiseOwn);
                }
            } });
        } else {
            steps.push({ type: 'sensors.noise', run: () => { sensorNoise.stop(serial); } });
        }
    } else if (sceneNoiseOwn.length > 0 && sensorNoise.isRunning(serial)) {
        steps.push({
            type: 'sensors.noise:yield',
            run: () => {
                const cur = (sensorNoise.getStatus(serial).owned) || [];
                sensorNoise.setOwned(serial, [...new Set([...cur, ...sceneNoiseOwn])]);
            },
        });
    }

    // ---- 3) Network — all five fields in ONE applyNetwork call ----
    const netFields = {};
    if (byType.has('network.signal')) netFields.signalProfile = byType.get('network.signal') === 'strong' ? 4 : 0;
    if (byType.has('network.speed')) netFields.networkType = byType.get('network.speed');
    if (byType.has('network.registration')) netFields.registration = byType.get('network.registration');
    if (byType.has('network.wifi')) netFields.wifi = byType.get('network.wifi') === true;
    if (byType.has('network.airplane')) netFields.airplane = byType.get('network.airplane') === true;
    if (Object.keys(netFields).length > 0) {
        steps.push({ type: 'network', run: () => network.applyNetwork(serial, netFields) });
    }

    // ---- 4) Battery — level + charging in ONE applyBattery call ----
    if (byType.has('battery.level') || byType.has('battery.charging')) {
        const b = {};
        if (byType.has('battery.level')) b.level = byType.get('battery.level');
        if (byType.has('battery.charging')) b.charging = byType.get('battery.charging') === true;
        steps.push({ type: 'battery', run: () => battery.applyBattery(serial, b) });
    }

    // ---- 5) Temperature (set-and-hold) ----
    if (byType.has('temperature.value')) {
        steps.push({ type: 'temperature.value', run: () => temperature.setDeviceTemperature(serial, Number(byType.get('temperature.value'))) });
    }

    // ---- 6) Light ----
    if (byType.has('light.lux')) {
        steps.push({ type: 'light.lux', run: () => light.setDeviceLight(serial, Number(byType.get('light.lux'))) });
    }

    // ---- 7) Pose (preset name -> angles) ----
    if (byType.has('pose.preset')) {
        const preset = POSE_PRESETS[byType.get('pose.preset')];
        if (preset) {
            steps.push({ type: 'pose.preset', run: () => pose.setDevicePoseRotation(serial, preset.pitch, preset.yaw, preset.roll) });
        } else {
            failures.push({ type: 'pose.preset', error: `unknown pose preset: ${byType.get('pose.preset')}` });
        }
    }

    // ---- 8) Bluetooth ----
    if (byType.has('bluetooth.on')) {
        steps.push({ type: 'bluetooth.on', run: () => bluetooth.setBt(serial, byType.get('bluetooth.on') === true) });
    }

    // ---- 9) Proxy (a scenario proxy.config always ENABLES; host required) ----
    if (byType.has('proxy.config')) {
        const cfg = byType.get('proxy.config') || {};
        steps.push({ type: 'proxy.config', run: () => proxy.setProxy(serial, cfg.host, Number(cfg.port)) });
    }

    // ---- 10) Phone number ----
    if (byType.has('phone.number')) {
        steps.push({ type: 'phone.number', run: () => phonenumber.setNumber(serial, byType.get('phone.number')) });
    }

    // ---- 11) Weather (needs a location; one-shot) ----
    if (byType.has('weather.on') && byType.get('weather.on') === true) {
        const loc = resolveLocation(serial, byType);
        if (loc) {
            steps.push({ type: 'weather.on', run: () => weather.applyWeather(serial, loc.lat, loc.lon) });
        } else {
            failures.push({ type: 'weather.on', error: 'weather needs a location — add "GPS location" to the scenario' });
        }
    }

    // ---- 12) BSSID sync (needs a location; one-shot) ----
    if (byType.has('bssid.on') && byType.get('bssid.on') === true) {
        const loc = resolveLocation(serial, byType);
        if (loc) {
            steps.push({ type: 'bssid.on', run: () => wifiGeo.applyBssidSync(serial, loc.lat, loc.lon) });
        } else {
            failures.push({ type: 'bssid.on', error: 'Wi-Fi (BSSID) sync needs a location — add "GPS location" to the scenario' });
        }
    }

    // Run sequentially with a small delay, collecting per-step failures (leaf domain
    // fns throw on failure; one failing step must not abort the rest of the scenario).
    for (let i = 0; i < steps.length; i++) {
        if (i > 0) await sleep(STEP_DELAY_MS);
        try {
            await steps[i].run();
            applied.push(steps[i].type);
        } catch (err) {
            failures.push({ type: steps[i].type, error: err && err.message ? err.message : String(err) });
        }
    }

    const ok = failures.length === 0;
    log.info({ serial, applied, failures }, ok ? 'scenario applied' : 'scenario applied with failures');
    return { ok, applied, failures };
}

module.exports = { applyScenario, POSE_PRESETS, NOISE_OWN };
