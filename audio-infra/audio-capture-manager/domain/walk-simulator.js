// audio-infra/audio-capture-manager/walk-simulator.js
//
// GPS walk simulator: takes a route (polyline of lat/lon points), walks along
// it at a configurable speed, calling setMockGpsLocation() once per second.
//
// Routing source: OSRM public demo server (router.project-osrm.org).
// Profiles: foot | bike | driving.
//
// Conflict policy with the regular GPS keepalive:
//   - startWalk() always stops keepalive for the same serial first.
//   - manager.js is expected to call stopWalk(serial) inside the regular
//     /api/gps/:serial handler, so that any manual GPS set/stop kills walk too.
//
// Lifecycle states: idle -> running -> (paused <-> running)* -> finished
// On 'finished' (and only if keepAliveAfterFinish=true), startGpsKeepAlive()
// is invoked on the last point so Android does not consider it stale.
//
// Time/distance accounting:
//   Single source of truth - session.accumulatedDistanceM (meters).
//   Each tick advances it by dt * currentSpeed. Progress, ETA, and the
//   currently applied location are all derived from this same field, so
//   the UI snapshot can never disagree with the actual mock-set location.

const https = require('https');

// ----- Configuration -----
const TICK_INTERVAL_MS    = 1000;
const SPEED_VAR_REFRESH_S = 5;
const SPEED_VAR_RANGE     = 0.15;
const DEFAULT_JITTER_M    = 0;      // off by default - too distracting visually
const MAX_JITTER_M        = 1;      // cap user-supplied jitter
const OSRM_HOST           = 'router.project-osrm.org';
const OSRM_TIMEOUT_MS     = 10000;
const ALLOWED_PROFILES    = new Set(['foot', 'bike', 'driving']);

const SPEED_PRESETS = {
    walking: 1.4,
    jogging: 2.5,
    running: 4.0,
    cycling: 5.5,
    driving: 13.9,
};

const walkSessions = new Map();

let _setMockGpsLocation = null;
let _startGpsKeepAlive = null;
let _stopGpsKeepAlive = null;

function init(deps) {
    _setMockGpsLocation = deps.setMockGpsLocation;
    _startGpsKeepAlive = deps.startGpsKeepAlive;
    _stopGpsKeepAlive = deps.stopGpsKeepAlive;
}

// ----- Geo helpers -----

function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const x = ((lon2 - lon1) * Math.PI / 180) * Math.cos((phi1 + phi2) / 2);
    const y = (lat2 - lat1) * Math.PI / 180;
    return Math.sqrt(x * x + y * y) * R;
}

function interpolate(p1, p2, f) {
    return {
        lat: p1.lat + (p2.lat - p1.lat) * f,
        lon: p1.lon + (p2.lon - p1.lon) * f,
    };
}

function addJitter(lat, lon, jitterMeters) {
    if (!jitterMeters || jitterMeters <= 0) return { lat: lat, lon: lon };
    const dLat = ((Math.random() - 0.5) * 2 * jitterMeters) / 111320;
    const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
    const dLon = ((Math.random() - 0.5) * 2 * jitterMeters) / (111320 * cosLat);
    return { lat: lat + dLat, lon: lon + dLon };
}

// ----- Polyline preprocessing -----

function buildPolyline(points) {
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error('polyline must contain at least 2 points');
    }
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
        const d = distanceMeters(
            points[i - 1].lat, points[i - 1].lon,
            points[i].lat,     points[i].lon
        );
        cum.push(cum[i - 1] + d);
    }
    const total = cum[cum.length - 1];

    function pointAt(distance) {
        if (distance <= 0) {
            return { lat: points[0].lat, lon: points[0].lon, segmentIndex: 0 };
        }
        if (distance >= total) {
            const last = points[points.length - 1];
            return { lat: last.lat, lon: last.lon, segmentIndex: points.length - 2 };
        }
        let lo = 0, hi = cum.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] <= distance) lo = mid; else hi = mid;
        }
        const segStart = cum[lo];
        const segLen = cum[lo + 1] - segStart;
        const f = segLen > 0 ? (distance - segStart) / segLen : 0;
        const interp = interpolate(points[lo], points[lo + 1], f);
        return { lat: interp.lat, lon: interp.lon, segmentIndex: lo };
    }

    return { points: points, cum: cum, total: total, pointAt: pointAt };
}

// ----- OSRM client -----

function osrmFetch(path) {
    return new Promise(function(resolve, reject) {
        const req = https.request({
            host: OSRM_HOST,
            path: path,
            method: 'GET',
            headers: { 'User-Agent': 'devicehub-walk-simulator/1.0' },
            timeout: OSRM_TIMEOUT_MS,
        }, function(res) {
            const chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    return reject(new Error('OSRM HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('OSRM returned invalid JSON: ' + e.message)); }
            });
        });
        req.on('timeout', function() { req.destroy(new Error('OSRM request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

async function fetchRoute(stops, profile) {
    if (!ALLOWED_PROFILES.has(profile)) {
        throw new Error('profile must be one of ' + Array.from(ALLOWED_PROFILES).join(', '));
    }
    if (!Array.isArray(stops) || stops.length < 2) {
        throw new Error('need at least 2 stops to build a route');
    }
    // OSRM expects lon,lat (GeoJSON convention)
    const coords = stops.map(function(s) { return s.lon + ',' + s.lat; }).join(';');
    const path = '/route/v1/' + profile + '/' + coords + '?overview=full&geometries=geojson&steps=false';
    const json = await osrmFetch(path);
    if (json.code !== 'Ok' || !json.routes || !json.routes[0]) {
        throw new Error('OSRM error: ' + (json.code || 'unknown') + ': ' + (json.message || ''));
    }
    const route = json.routes[0];
    const points = route.geometry.coordinates.map(function(c) {
        return { lat: c[1], lon: c[0] };
    });
    return {
        points: points,
        distanceM: route.distance,
        durationS: route.duration,
    };
}

// ----- Session lifecycle -----

function statusSnapshot(session) {
    if (!session) return null;

    // Single source of truth: distance accumulated by the ticker.
    const distanceCovered = Math.min(
        session.polyline.total,
        session.accumulatedDistanceM
    );
    const fraction = session.polyline.total > 0
        ? distanceCovered / session.polyline.total
        : 1;
    const remainingDistance = Math.max(0, session.polyline.total - distanceCovered);
    const etaSeconds = session.currentSpeed > 0
        ? Math.round(remainingDistance / session.currentSpeed)
        : null;

    return {
        serial:           session.serial,
        status:           session.status,
        profile:          session.profile,
        nominalSpeed:     session.nominalSpeed,
        currentSpeed:     session.currentSpeed,
        jitter:           session.jitter,
        jitterMeters:     session.jitterMeters,
        speedVariance:    session.speedVariance,
        keepAliveAfterFinish: session.keepAliveAfterFinish,
        startedAt:        session.startedAt,
        finishedAt:       session.finishedAt,
        totalDistanceM:   Math.round(session.polyline.total),
        coveredDistanceM: Math.round(distanceCovered),
        progress:         Number(fraction.toFixed(4)),
        etaSeconds:       etaSeconds,
        currentPoint:     session.currentPoint,
        targetPoint:      session.polyline.points[session.polyline.points.length - 1],
        polylinePoints:   session.polyline.points.length,
        lastError:        session.lastError,
    };
}

async function startWalk(serial, opts) {
    opts = opts || {};
    if (!_setMockGpsLocation || !_startGpsKeepAlive || !_stopGpsKeepAlive) {
        throw new Error('walk-simulator not initialized');
    }

    let stops;
    if (Array.isArray(opts.waypoints) && opts.waypoints.length >= 2) {
        stops = opts.waypoints;
    } else if (opts.from && opts.to) {
        stops = [opts.from, opts.to];
    } else {
        throw new Error('provide either {from,to} or {waypoints:[...]}');
    }
    for (const s of stops) {
        if (typeof s.lat !== 'number' || typeof s.lon !== 'number'
            || s.lat < -90 || s.lat > 90 || s.lon < -180 || s.lon > 180) {
            throw new Error('invalid waypoint: ' + JSON.stringify(s));
        }
    }

    const profile = opts.profile && ALLOWED_PROFILES.has(opts.profile)
        ? opts.profile
        : 'foot';

    let nominalSpeed;
    if (typeof opts.speed === 'number' && opts.speed > 0 && opts.speed < 100) {
        nominalSpeed = opts.speed;
    } else if (typeof opts.speed === 'string' && SPEED_PRESETS[opts.speed]) {
        nominalSpeed = SPEED_PRESETS[opts.speed];
    } else {
        nominalSpeed = SPEED_PRESETS.walking;
    }

    const jitter = opts.jitter === true; // default false now
    const jitterMeters = (typeof opts.jitterMeters === 'number' && opts.jitterMeters >= 0)
        ? Math.min(opts.jitterMeters, MAX_JITTER_M)
        : DEFAULT_JITTER_M;
    const speedVariance = opts.speedVariance !== false;
    const keepAliveAfterFinish = opts.keepAliveAfterFinish !== false;

    _stopGpsKeepAlive(serial);
    stopWalk(serial);

    console.log('[walk] Building route for ' + serial + ': ' + stops.length + ' stops, profile=' + profile);
    const route = await fetchRoute(stops, profile);
    if (route.points.length < 2) {
        throw new Error('OSRM returned a degenerate route (<2 points)');
    }
    const polyline = buildPolyline(route.points);
    console.log(
        '[walk] Route: ' + polyline.points.length + ' pts, ' +
        'distance=' + Math.round(polyline.total) + 'm, ' +
        'nominal speed=' + nominalSpeed + ' m/s, ' +
        'ETA=' + Math.round(polyline.total / nominalSpeed) + 's'
    );

    const now = Date.now();
    const session = {
        serial: serial,
        status: 'running',
        profile: profile,
        polyline: polyline,
        nominalSpeed: nominalSpeed,
        currentSpeed: nominalSpeed,
        jitter: jitter,
        jitterMeters: jitterMeters,
        speedVariance: speedVariance,
        keepAliveAfterFinish: keepAliveAfterFinish,
        accumulatedDistanceM: 0,
        lastTickAt: now,
        lastSpeedSampleAt: now,
        currentPoint: { lat: polyline.points[0].lat, lon: polyline.points[0].lon },
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
        lastError: null,
        timer: null,
        applying: false,
    };
    walkSessions.set(serial, session);

    try {
        const p0 = jitter
            ? addJitter(session.currentPoint.lat, session.currentPoint.lon, jitterMeters)
            : session.currentPoint;
        await _setMockGpsLocation(serial, p0.lat, p0.lon, 'gps');
    } catch (err) {
        session.lastError = err.message;
        console.error('[walk] Initial location apply failed for ' + serial + ': ' + err.message);
    }

    session.timer = setInterval(function() { void tick(serial); }, TICK_INTERVAL_MS);

    return statusSnapshot(session);
}

async function tick(serial) {
    const session = walkSessions.get(serial);
    if (!session || session.status !== 'running') return;
    if (session.applying) return;
    session.applying = true;
    try {
        const now = Date.now();
        const dt = Math.max(0, now - session.lastTickAt);
        session.lastTickAt = now;

        if (session.speedVariance &&
            now - session.lastSpeedSampleAt >= SPEED_VAR_REFRESH_S * 1000) {
            const k = 1 + (Math.random() * 2 - 1) * SPEED_VAR_RANGE;
            session.currentSpeed = Math.max(0.05, session.nominalSpeed * k);
            session.lastSpeedSampleAt = now;
        }

        // Integrate distance: dt * currentSpeed.
        session.accumulatedDistanceM += (dt / 1000) * session.currentSpeed;

        const reachedEnd = session.accumulatedDistanceM >= session.polyline.total;
        const targetD = reachedEnd ? session.polyline.total : session.accumulatedDistanceM;
        if (reachedEnd) session.accumulatedDistanceM = session.polyline.total;

        const p = session.polyline.pointAt(targetD);
        const out = session.jitter
            ? addJitter(p.lat, p.lon, session.jitterMeters)
            : { lat: p.lat, lon: p.lon };
        session.currentPoint = out;

        await _setMockGpsLocation(serial, out.lat, out.lon, 'gps');
        session.lastError = null;

        if (reachedEnd) {
            await finishWalk(serial);
        }
    } catch (err) {
        session.lastError = err.message;
        console.error('[walk] tick failed for ' + serial + ': ' + err.message);
    } finally {
        session.applying = false;
    }
}

async function finishWalk(serial) {
    const session = walkSessions.get(serial);
    if (!session) return;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    session.status = 'finished';
    session.finishedAt = new Date().toISOString();

    const last = session.polyline.points[session.polyline.points.length - 1];
    console.log(
        '[walk] Finished ' + serial + ' at ' + last.lat + ',' + last.lon +
        ' (distance=' + Math.round(session.polyline.total) + 'm)'
    );

    if (session.keepAliveAfterFinish) {
        try {
            await _startGpsKeepAlive(serial, last.lat, last.lon, 'gps');
            console.log('[walk] Handed off to GPS keepalive at final point for ' + serial);
        } catch (err) {
            console.error('[walk] Failed to hand off to keepalive for ' + serial + ': ' + err.message);
        }
    }
}

function pauseWalk(serial) {
    const session = walkSessions.get(serial);
    if (!session) return false;
    if (session.status !== 'running') return false;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    session.status = 'paused';

    // Hold the current point alive while paused — otherwise Android marks
    // the location stale after ~20s and apps lose the fix.
    // Use the same keepalive mechanism as the post-finish handoff.
    const cp = session.currentPoint;
    if (cp && _startGpsKeepAlive) {
        _startGpsKeepAlive(serial, cp.lat, cp.lon, 'gps').catch(function(err) {
            console.error('[walk] Failed to start pause-keepalive for ' + serial + ': ' + err.message);
        });
    }

    console.log(
        '[walk] Paused ' + serial +
        ' (covered=' + Math.round(session.accumulatedDistanceM) + 'm / ' +
        Math.round(session.polyline.total) + 'm) — keepalive armed'
    );
    return true;
}

function resumeWalk(serial) {
    const session = walkSessions.get(serial);
    if (!session) return false;
    if (session.status !== 'paused') return false;

    // Drop the pause-time keepalive so it doesn't fight with the ticker.
    if (_stopGpsKeepAlive) _stopGpsKeepAlive(serial);

    session.status = 'running';
    // Critical: reset lastTickAt to NOW. Without this, the first tick after
    // resume would compute dt = (now - lastTickAt_at_pause_time) and jump
    // the location forward by the entire pause duration.
    session.lastTickAt = Date.now();
    session.timer = setInterval(function() { void tick(serial); }, TICK_INTERVAL_MS);
    console.log('[walk] Resumed ' + serial);
    return true;
}

function stopWalk(serial) {
    const session = walkSessions.get(serial);
    if (!session) return false;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    // If the session was paused, a keepalive is holding the current point —
    // drop it as well, otherwise it will outlive the walk.
    if (session.status === 'paused' && _stopGpsKeepAlive) {
        _stopGpsKeepAlive(serial);
    }
    walkSessions.delete(serial);
    console.log('[walk] Stopped ' + serial);
    return true;
}

function getStatus(serial) {
    return statusSnapshot(walkSessions.get(serial));
}

function getAllStatuses() {
    const out = {};
    for (const [serial, session] of walkSessions) {
        out[serial] = statusSnapshot(session);
    }
    return out;
}

function shutdown() {
    for (const serial of Array.from(walkSessions.keys())) {
        stopWalk(serial);
    }
}

module.exports = {
    init: init,
    startWalk: startWalk,
    pauseWalk: pauseWalk,
    resumeWalk: resumeWalk,
    stopWalk: stopWalk,
    getStatus: getStatus,
    getAllStatuses: getAllStatuses,
    shutdown: shutdown,
    SPEED_PRESETS: SPEED_PRESETS,
};
