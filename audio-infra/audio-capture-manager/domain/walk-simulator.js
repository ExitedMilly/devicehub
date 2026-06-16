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
const fs = require('fs');
const log = require('../log').getLogger('domain/walk-simulator');

// ----- Configuration -----
const TICK_INTERVAL_MS    = 1000;
const SPEED_VAR_REFRESH_S = 5;
const SPEED_VAR_RANGE     = 0.15;
const DEFAULT_JITTER_M    = 0;      // off by default - too distracting visually
const MAX_JITTER_M        = 1;      // cap user-supplied jitter
const OSRM_HOST           = 'router.project-osrm.org';
const OSRM_TIMEOUT_MS     = 10000;
const ALLOWED_PROFILES    = new Set(['foot', 'bike', 'driving']);

// Offline route cache: persisted LRU so GPS walks survive OSRM outages.
const ROUTE_CACHE_PATH    = '/backups/route-cache.json';
const ROUTE_CACHE_MAX     = 10;

// GPS movement profile -> matching accelerometer (pose) scenario name.
// Keys are SCENARIOS keys in pose-scenario.js.
const PROFILE_TO_SCENARIO = {
    foot:    'walking',
    bike:    'cycling',
    driving: 'driving',
};

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

// Pose-scenario controls (auto-sync accelerometer with GPS movement).
let _startScenario = null;
let _stopScenario = null;
let _isScenarioRunning = null;
let _pauseScenario = null;
let _resumeScenario = null;
let _resetScenario = null;   // stopScenarioAndReset: stop + return device to flat

function init(deps) {
    _setMockGpsLocation = deps.setMockGpsLocation;
    _startGpsKeepAlive = deps.startGpsKeepAlive;
    _stopGpsKeepAlive = deps.stopGpsKeepAlive;
    _startScenario = deps.startScenario;
    _stopScenario = deps.stopScenario;
    _isScenarioRunning = deps.isScenarioRunning;
    _pauseScenario = deps.pauseScenario;
    _resumeScenario = deps.resumeScenario;
    _resetScenario = deps.stopScenarioAndReset;
    loadRouteCache();
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

// ----- Route cache (offline LRU) -----
//
// Best-effort LRU of the last ROUTE_CACHE_MAX OSRM routes, persisted to
// ROUTE_CACHE_PATH. On OSRM failure we serve a matching cached route so GPS
// walk simulation keeps working when router.project-osrm.org is unreachable.
// Disk errors NEVER break a route request - the cache is purely additive.

// Insertion-ordered Map: first key = oldest (eviction target), last = newest.
const routeCache = new Map();
let _routeCacheLoaded = false;

function routeCacheKey(stops, profile) {
    return profile + ':' + stops.map(function(s) {
        return s.lat.toFixed(5) + ',' + s.lon.toFixed(5);
    }).join(';');
}

function loadRouteCache() {
    if (_routeCacheLoaded) return;
    _routeCacheLoaded = true;
    let raw;
    try {
        raw = fs.readFileSync(ROUTE_CACHE_PATH, 'utf8');
    } catch (err) {
        // Missing file is the normal first-run case - nothing to load.
        if (err.code !== 'ENOENT') {
            log.warn({ path: ROUTE_CACHE_PATH, err: err.message }, 'Route cache unreadable, starting empty');
        }
        return;
    }
    try {
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed) ? parsed : [];
        for (const e of entries) {
            if (e && typeof e.key === 'string' && e.value) {
                routeCache.set(e.key, e.value);
            }
        }
        // Trim to the cap in case the file held more (oldest first).
        while (routeCache.size > ROUTE_CACHE_MAX) {
            routeCache.delete(routeCache.keys().next().value);
        }
        log.info({ path: ROUTE_CACHE_PATH, entries: routeCache.size }, 'Route cache loaded');
    } catch (err) {
        log.warn({ path: ROUTE_CACHE_PATH, err: err.message }, 'Route cache corrupt, starting empty');
    }
}

function persistRouteCache() {
    // Serialize newest-last so insertion order is preserved on reload.
    const entries = [];
    for (const [key, value] of routeCache) {
        entries.push({ key: key, value: value });
    }
    const tmp = ROUTE_CACHE_PATH + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(entries), 'utf8');
        fs.renameSync(tmp, ROUTE_CACHE_PATH);
    } catch (err) {
        log.warn({ path: ROUTE_CACHE_PATH, err: err.message }, 'Route cache persist failed (best-effort)');
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
}

function cacheStoreRoute(key, route) {
    // Re-insert at the end (most-recent) and evict the oldest beyond the cap.
    if (routeCache.has(key)) routeCache.delete(key);
    routeCache.set(key, {
        points: route.points,
        distanceM: route.distanceM,
        durationS: route.durationS,
        cachedAt: new Date().toISOString(),
    });
    while (routeCache.size > ROUTE_CACHE_MAX) {
        routeCache.delete(routeCache.keys().next().value);
    }
    persistRouteCache();
}

function cacheLookupRoute(key) {
    if (!routeCache.has(key)) return null;
    const value = routeCache.get(key);
    // Mark as most-recently-used (LRU touch); not persisted - order on disk
    // only matters for eviction priority across restarts.
    routeCache.delete(key);
    routeCache.set(key, value);
    return value;
}

// Inner OSRM-only route build (the original fetchRoute logic, unchanged).
async function fetchRouteOsrm(stops, profile) {
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

async function fetchRoute(stops, profile) {
    if (!ALLOWED_PROFILES.has(profile)) {
        throw new Error('profile must be one of ' + Array.from(ALLOWED_PROFILES).join(', '));
    }
    if (!Array.isArray(stops) || stops.length < 2) {
        throw new Error('need at least 2 stops to build a route');
    }
    loadRouteCache();
    const key = routeCacheKey(stops, profile);

    let route;
    try {
        route = await fetchRouteOsrm(stops, profile);
    } catch (osrmErr) {
        // OSRM unreachable - fall back to a cached route if we have one.
        const cached = cacheLookupRoute(key);
        if (cached) {
            log.warn({ key: key, cachedAt: cached.cachedAt, err: osrmErr.message },
                'OSRM unreachable, serving cached route');
            return {
                points: cached.points,
                distanceM: cached.distanceM,
                durationS: cached.durationS,
                fromCache: true,
            };
        }
        // Nothing to fall back to - rethrow the original OSRM error.
        throw osrmErr;
    }

    // OSRM succeeded - refresh the cache (best-effort) and return live result.
    cacheStoreRoute(key, route);
    return {
        points: route.points,
        distanceM: route.distanceM,
        durationS: route.durationS,
        fromCache: false,
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
    // When true, pausing the walk also pauses the auto-synced accelerometer
    // scenario (and resuming the walk resumes it). Default false: the
    // accelerometer keeps ticking through a walk pause.
    const pauseAccelOnWalkPause = opts.pauseAccelOnWalkPause === true;

    _stopGpsKeepAlive(serial);
    stopWalk(serial);

    log.info({ serial, stops: stops.length, profile }, 'Building route');
    const route = await fetchRoute(stops, profile);
    if (route.points.length < 2) {
        throw new Error('OSRM returned a degenerate route (<2 points)');
    }
    const polyline = buildPolyline(route.points);
    log.info({ serial, points: polyline.points.length, distanceM: Math.round(polyline.total), nominalSpeed, etaSeconds: Math.round(polyline.total / nominalSpeed) }, 'Route built');

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
        pauseAccelOnWalkPause: pauseAccelOnWalkPause,
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
        log.error({ serial, err: err.message }, 'Initial location apply failed');
    }

    session.timer = setInterval(function() { void tick(serial); }, TICK_INTERVAL_MS);

    // Auto-sync the accelerometer (pose) scenario with this GPS walk. Best-effort:
    // a pose failure must never break the walk (GPS is the primary function).
    syncPoseWithWalk(session, profile);

    return statusSnapshot(session);
}

// Start the matching pose scenario for a freshly-started walk, unless one is
// already running (manual or otherwise) - we never disturb a scenario we did
// not start. Records on the session whether walk owns the scenario, so
// stopWalk knows whether to clean it up.
function syncPoseWithWalk(session, profile) {
    session.poseStartedByWalk = false;
    const scenario = PROFILE_TO_SCENARIO[profile];
    if (!scenario) return; // unmapped profile - nothing to sync
    if (!_startScenario || !_isScenarioRunning) return; // pose controls not wired
    try {
        if (_isScenarioRunning(session.serial)) {
            // A scenario is already active - leave it untouched.
            log.info({ serial: session.serial, scenario }, 'Pose scenario already running, not auto-starting');
            return;
        }
        // startScenario is async; mark ownership optimistically and handle a
        // late rejection without breaking the walk (and without an unhandled
        // rejection). On failure we clear ownership so stopWalk won't try to
        // stop a scenario that never started.
        session.poseStartedByWalk = true;
        Promise.resolve(_startScenario(session.serial, { scenario: scenario }))
            .then(function() {
                log.info({ serial: session.serial, scenario, profile }, 'Auto-started pose scenario for walk');
            })
            .catch(function(err) {
                session.poseStartedByWalk = false;
                log.warn({ serial: session.serial, scenario, err: err.message }, 'Auto-start of pose scenario failed (walk continues)');
            });
    } catch (err) {
        session.poseStartedByWalk = false;
        log.warn({ serial: session.serial, scenario, err: err.message }, 'Auto-start of pose scenario failed (walk continues)');
    }
}

// Tear down the pose scenario when a walk ends (explicit stop OR natural
// finish). Only touches a scenario the walk itself started - a manually
// started scenario is never disturbed. Prefers stopScenarioAndReset so the
// accelerometer returns to a neutral flat pose instead of freezing tilted;
// falls back to a plain stop if reset is not wired (older deployments).
// Best-effort: never throws, never blocks walk teardown.
function teardownPoseForWalk(serial, session) {
    if (!session || session.poseStartedByWalk !== true) return;
    // Clear ownership up-front so a later stop after a natural finish does not
    // redo the teardown.
    session.poseStartedByWalk = false;
    const reset = _resetScenario || _stopScenario;
    if (!reset) return;
    try {
        // stopScenarioAndReset is async (heavy neutral apply); stopScenario is
        // sync. Promise.resolve() handles both and swallows a late rejection.
        Promise.resolve(reset(serial))
            .then(function() {
                log.info({ serial }, 'Pose scenario torn down on walk end');
            })
            .catch(function(err) {
                log.warn({ serial, err: err.message }, 'Pose teardown failed (walk continues)');
            });
    } catch (err) {
        log.warn({ serial, err: err.message }, 'Pose teardown failed (walk continues)');
    }
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
        log.error({ serial, err: err.message }, 'Tick failed');
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
    log.info({ serial, lat: last.lat, lon: last.lon, distanceM: Math.round(session.polyline.total) }, 'Walk finished');

    // A naturally-finished route ends movement too - return the accelerometer
    // to neutral if this walk auto-started the scenario (never touch a manual
    // one). Best-effort.
    teardownPoseForWalk(serial, session);

    if (session.keepAliveAfterFinish) {
        try {
            await _startGpsKeepAlive(serial, last.lat, last.lon, 'gps');
            log.info({ serial }, 'Handed off to GPS keepalive at final point');
        } catch (err) {
            log.error({ serial, err: err.message }, 'Failed to hand off to keepalive');
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
            log.error({ serial, err: err.message }, 'Failed to start pause-keepalive');
        });
    }

    // Optionally pause the auto-synced accelerometer scenario alongside the
    // walk (only if the walk owns it). Best-effort. When the option is off the
    // accelerometer keeps ticking through the pause.
    if (session.pauseAccelOnWalkPause && session.poseStartedByWalk === true && _pauseScenario) {
        try {
            _pauseScenario(serial);
            log.info({ serial }, 'Paused pose scenario with walk');
        } catch (err) {
            log.warn({ serial, err: err.message }, 'Pause of pose scenario failed (walk continues)');
        }
    }

    log.info({ serial, coveredM: Math.round(session.accumulatedDistanceM), totalM: Math.round(session.polyline.total) }, 'Walk paused');
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

    // Mirror pauseWalk: resume the accelerometer scenario if the walk paused it.
    // Best-effort.
    if (session.pauseAccelOnWalkPause && session.poseStartedByWalk === true && _resumeScenario) {
        try {
            _resumeScenario(serial);
            log.info({ serial }, 'Resumed pose scenario with walk');
        } catch (err) {
            log.warn({ serial, err: err.message }, 'Resume of pose scenario failed (walk continues)');
        }
    }

    log.info({ serial }, 'Walk resumed');
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
    // If this walk auto-started the pose scenario, it owns the cleanup and
    // resets the accelerometer to neutral. Never stop a manually-started
    // scenario. Best-effort: a failure here must not block walk teardown.
    teardownPoseForWalk(serial, session);
    walkSessions.delete(serial);
    log.info({ serial }, 'Walk stopped');
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
