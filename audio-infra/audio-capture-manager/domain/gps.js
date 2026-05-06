'use strict';

const { runAdb } = require('../adb-runner');
const { gpsSessions } = require('../stores');
const { GPS_KEEPALIVE_INTERVAL_MS } = require('../config');

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

async function setMockGpsLocation(serial, latitude, longitude, provider = 'gps') {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const normalizedProvider = normalizeGpsProvider(provider);

    console.log(
        `[gps] Applying mock location to ${serial}: provider=${normalizedProvider}, lat=${lat}, lon=${lon}`
    );

    await runAdb(serial, ['shell', 'cmd', 'location', 'set-location-enabled', 'true']);
    await runAdb(serial, ['shell', 'appops', 'set', '2000', 'android:mock_location', 'allow']);

    const addProviderResult = await runAdb(
        serial,
        ['shell', 'cmd', 'location', 'providers', 'add-test-provider', normalizedProvider],
        { allowFailure: true }
    );

    if (
        !addProviderResult.ok &&
        !/already exists|already added|Duplicate/i.test(
            `${addProviderResult.stderr}\n${addProviderResult.stdout}`
        )
    ) {
        throw new Error(
            `failed to add test provider "${normalizedProvider}": ` +
            (addProviderResult.stderr || addProviderResult.stdout || 'unknown error')
        );
    }

    await runAdb(serial, [
        'shell',
        'cmd',
        'location',
        'providers',
        'set-test-provider-enabled',
        normalizedProvider,
        'true',
    ]);

    // IMPORTANT: cmd location expects LATITUDE,LONGITUDE
    await runAdb(serial, [
        'shell',
        'cmd',
        'location',
        'providers',
        'set-test-provider-location',
        normalizedProvider,
        '--location',
        `${lat},${lon}`,
    ]);

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
    console.log('[gps] Keepalive stopped for ' + serial);
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
    };

    session.timer = setInterval(async () => {
        if (session.running) return;

        session.running = true;
        try {
            await setMockGpsLocation(serial, session.latitude, session.longitude, session.provider);
            session.lastAppliedAt = new Date().toISOString();
            session.lastError = null;
            console.log(
                '[gps] Keepalive refresh for ' + serial +
                ': ' + session.latitude + ',' + session.longitude +
                ' provider=' + session.provider
            );
        } catch (err) {
            session.lastError = err.message;
            console.error('[gps] Keepalive refresh failed for ' + serial + ': ' + err.message);
        } finally {
            session.running = false;
        }
    }, session.intervalMs);

    gpsSessions.set(serial, session);

    console.log(
        '[gps] Keepalive started for ' + serial +
        ': provider=' + normalizedProvider +
        ', lat=' + lat +
        ', lon=' + lon +
        ', interval=' + normalizedIntervalMs + 'ms'
    );

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
