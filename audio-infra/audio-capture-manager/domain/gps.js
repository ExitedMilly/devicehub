'use strict';

const { runAdb } = require('../adb-runner');
const { gpsSessions } = require('../stores');
const { GPS_KEEPALIVE_INTERVAL_MS } = require('../config');
const log = require('../log').getLogger('domain/gps');

// A failing keepalive used to retry at full rate forever, filling the log with an identical
// pair of lines every 20s for a cause that never fixes itself. It now backs off and then
// gives up.
//
// Why give up at all: the keepalive only re-asserts a location the user already set. Once
// it is clearly not getting through, continuing is noise, not resilience — and the operator
// needs to SEE that GPS stopped rather than have it silently fail forever.
//
// Why 10 and not 3: the common transient is a guest reboot, during which adb is unreachable
// for roughly a minute and a half. Giving up inside that window would turn a routine reboot
// into a dead session, which is exactly the bug being fixed. With the multipliers below the
// ten attempts stretch over ~40 minutes of continuous failure (20s, 40s, 80s, 160s, then
// 320s each), so a reboot is ridden out comfortably while a genuinely stuck device is
// abandoned within the hour, having logged ten lines instead of a hundred.
const KEEPALIVE_MAX_FAILURES = 10;
const KEEPALIVE_BACKOFF_MULTIPLIERS = [1, 2, 4, 8, 16];

function normalizeGpsProvider(provider) {
    const allowed = new Set(['gps', 'fused', 'network', 'passive']);
    if (!provider || typeof provider !== 'string') return 'gps';
    const normalized = provider.trim().toLowerCase();
    return allowed.has(normalized) ? normalized : 'gps';
}

function validateCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat)) {
        throw new Error('latitude must be a valid number');
    }
    if (!Number.isFinite(lon)) {
        throw new Error('longitude must be a valid number');
    }
    if (lat < -90 || lat > 90) {
        throw new Error('latitude must be between -90 and 90');
    }
    if (lon < -180 || lon > 180) {
        throw new Error('longitude must be between -180 and 180');
    }

    return { lat, lon };
}

// Applying a location is really two different jobs, and they used to be one:
//
//   SETUP  — enable location, grant android:mock_location to uid 2000 (shell, which is
//            what adbd runs as; never `adb root`, that stops minicap and kills the screen),
//            register the test provider and enable it. Four adb calls.
//   PUSH   — hand the provider a new coordinate. One adb call.
//
// SETUP state is runtime-only and does NOT survive a reboot of the guest: the appops grant
// resets and the test provider disappears, so every later push fails with a
// SecurityException about MOCK_LOCATION until setup is redone.
//
// Doing SETUP on every apply (the old behaviour) hid that, but at a price: the keepalive
// paid five adb calls every 20s and the walk simulator paid five EVERY SECOND. So setup is
// now memoised per serial+provider and skipped while it is known good, and correctness is
// kept by self-healing instead: if a push fails, the memo is dropped, setup is re-run and
// the push retried once. A guest reboot therefore costs one failed push and repairs itself
// on the spot — no manager restart, and no extra adb traffic in the steady state.
//
// Every step is idempotent: `appops set ... allow` is a plain assignment, add-test-provider
// tolerates an existing provider, set-test-provider-enabled true is a no-op when enabled.
const mockSetupDone = new Map(); // `${serial}|${provider}` -> true once SETUP succeeded

function setupKey(serial, provider) {
    return `${serial}|${provider}`;
}

function invalidateMockSetup(serial, provider) {
    mockSetupDone.delete(setupKey(serial, provider));
}

async function ensureMockSetup(serial, provider) {
    if (mockSetupDone.get(setupKey(serial, provider))) return false;

    await runAdb(serial, ['shell', 'cmd', 'location', 'set-location-enabled', 'true']);
    // uid 2000 = shell. adbd runs as shell, so this is the uid that drives `cmd location`.
    await runAdb(serial, ['shell', 'appops', 'set', '2000', 'android:mock_location', 'allow']);

    const addProviderResult = await runAdb(
        serial,
        ['shell', 'cmd', 'location', 'providers', 'add-test-provider', provider],
        { allowFailure: true }
    );

    if (
        !addProviderResult.ok &&
        !/already exists|already added|Duplicate/i.test(
            `${addProviderResult.stderr}\n${addProviderResult.stdout}`
        )
    ) {
        throw new Error(
            `failed to add test provider "${provider}": ` +
            (addProviderResult.stderr || addProviderResult.stdout || 'unknown error')
        );
    }

    await runAdb(serial, [
        'shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', provider, 'true',
    ]);

    mockSetupDone.set(setupKey(serial, provider), true);
    return true;
}

async function pushMockLocation(serial, provider, lat, lon) {
    // IMPORTANT: cmd location expects LATITUDE,LONGITUDE
    await runAdb(serial, [
        'shell', 'cmd', 'location', 'providers', 'set-test-provider-location', provider,
        '--location', `${lat},${lon}`,
    ]);
}

async function setMockGpsLocation(serial, latitude, longitude, provider = 'gps') {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const normalizedProvider = normalizeGpsProvider(provider);

    try {
        await ensureMockSetup(serial, normalizedProvider);
        await pushMockLocation(serial, normalizedProvider, lat, lon);
    } catch (err) {
        // The usual cause is a guest reboot: the grant and the provider are gone, so the
        // push is rejected. Drop the memo, redo setup and try once more. If that fails too
        // the device is genuinely unreachable and the error is propagated to the caller.
        invalidateMockSetup(serial, normalizedProvider);
        log.warn({ serial, provider: normalizedProvider, err: err.message },
            'Mock location push failed, re-running setup (guest reboot?)');
        await ensureMockSetup(serial, normalizedProvider);
        await pushMockLocation(serial, normalizedProvider, lat, lon);
        log.info({ serial, provider: normalizedProvider }, 'Mock location setup restored');
    }

    return {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
    };
}

function stopGpsKeepAlive(serial) {
    const session = gpsSessions.get(serial);
    if (!session) return false;

    if (session.timer) {
        clearInterval(session.timer);
        session.timer = null;
    }

    gpsSessions.delete(serial);
    log.info({ serial }, 'Keepalive stopped');
    return true;
}

function getGpsSessionsStatus() {
    const result = {};
    for (const [serial, session] of gpsSessions) {
        result[serial] = {
            serial: session.serial,
            provider: session.provider,
            latitude: session.latitude,
            longitude: session.longitude,
            intervalMs: session.intervalMs,
            startedAt: session.startedAt,
            lastAppliedAt: session.lastAppliedAt,
            lastError: session.lastError,
            running: session.running,
            consecutiveFailures: session.consecutiveFailures,
        };
    }
    return result;
}

async function startGpsKeepAlive(serial, latitude, longitude, provider = 'gps', intervalMs = GPS_KEEPALIVE_INTERVAL_MS) {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const normalizedProvider = normalizeGpsProvider(provider);
    const normalizedIntervalMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 5000
        ? Number(intervalMs)
        : GPS_KEEPALIVE_INTERVAL_MS;

    stopGpsKeepAlive(serial);

    await setMockGpsLocation(serial, lat, lon, normalizedProvider);

    const session = {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
        intervalMs: normalizedIntervalMs,
        timer: null,
        running: false,
        startedAt: new Date().toISOString(),
        lastAppliedAt: new Date().toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        skipUntil: 0,
    };

    session.timer = setInterval(async () => {
        if (session.running) return;
        // Backoff: a tick that lands inside the penalty window is skipped, so the timer
        // itself keeps its base period and only the attempt rate drops.
        if (session.skipUntil && Date.now() < session.skipUntil) return;

        session.running = true;
        try {
            await setMockGpsLocation(serial, session.latitude, session.longitude, session.provider);
            session.lastAppliedAt = new Date().toISOString();
            const recovered = session.consecutiveFailures > 0;
            session.consecutiveFailures = 0;
            session.skipUntil = 0;
            session.lastError = null;
            if (recovered) {
                log.info({ serial, lat: session.latitude, lon: session.longitude }, 'Keepalive recovered');
            } else {
                // Routine refreshes are debug: one info line every 20s per device is pure noise.
                log.debug({ serial, lat: session.latitude, lon: session.longitude, provider: session.provider }, 'Keepalive refresh');
            }
        } catch (err) {
            session.consecutiveFailures += 1;
            session.lastError = err.message;

            if (session.consecutiveFailures >= KEEPALIVE_MAX_FAILURES) {
                log.error({
                    serial,
                    failures: session.consecutiveFailures,
                    err: err.message,
                }, 'Keepalive giving up after repeated failures — the location will no longer ' +
                   'be refreshed for this device. Apply a location again to restart it.');
                stopGpsKeepAlive(serial);
                return;
            }

            const multiplier = KEEPALIVE_BACKOFF_MULTIPLIERS[
                Math.min(session.consecutiveFailures - 1, KEEPALIVE_BACKOFF_MULTIPLIERS.length - 1)
            ];
            session.skipUntil = Date.now() + session.intervalMs * multiplier;
            log.warn({
                serial,
                attempt: session.consecutiveFailures,
                of: KEEPALIVE_MAX_FAILURES,
                nextTryInMs: session.intervalMs * multiplier,
                err: err.message,
            }, 'Keepalive refresh failed, backing off');
        } finally {
            session.running = false;
        }
    }, session.intervalMs);

    gpsSessions.set(serial, session);

    log.info({ serial, provider: normalizedProvider, lat, lon, intervalMs: normalizedIntervalMs }, 'Keepalive started');

    return {
        serial,
        provider: normalizedProvider,
        latitude: lat,
        longitude: lon,
        keepAlive: true,
        intervalMs: normalizedIntervalMs,
        startedAt: session.startedAt,
    };
}

module.exports = {
    normalizeGpsProvider,
    validateCoordinates,
    setMockGpsLocation,
    stopGpsKeepAlive,
    getGpsSessionsStatus,
    startGpsKeepAlive,
};
