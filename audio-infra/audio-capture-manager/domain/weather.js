'use strict';

// Open-Meteo weather client (free, no API key, no registration). Given (lat,lon),
// fetches the CURRENT temperature/humidity/pressure and applies them to the device
// sensors via the emulator console (`sensor set`). Open-Meteo's units match the
// sensors exactly: temperature °C, relative humidity %, surface pressure hPa.
//
// Coordination: the frontend "Weather from location" owner claims the temperature/
// humidity/pressure resources in the scenario resource model, so sensor-noise yields
// those sensors while weather is active (same mechanism as the manual temperature
// operblock). This module only fetches + sets — ownership/skip lives in the model.

const https = require('https');
const { consoleExec } = require('../console-client');
const log = require('../log').getLogger('domain/weather');

const OPEN_METEO_HOST = 'api.open-meteo.com';
const REQUEST_TIMEOUT_MS = 8000;
const CONSOLE_TIMEOUT_MS = 6000;

function validateCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new Error('latitude must be between -90 and 90');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new Error('longitude must be between -180 and 180');
    }
    return { lat, lon };
}

// GET current weather from Open-Meteo. Rejects on network / timeout / HTTP / parse.
function fetchOpenMeteo(lat, lon) {
    const path = '/v1/forecast?latitude=' + encodeURIComponent(lat) +
        '&longitude=' + encodeURIComponent(lon) +
        '&current=temperature_2m,relative_humidity_2m,surface_pressure';

    return new Promise(function (resolve, reject) {
        const req = https.request({
            host: OPEN_METEO_HOST,
            path: path,
            method: 'GET',
            headers: { 'User-Agent': 'devicehub-weather/1.0', 'Accept': 'application/json' },
            timeout: REQUEST_TIMEOUT_MS,
        }, function (res) {
            const chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    return reject(new Error('Open-Meteo HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                }
                let json;
                try { json = JSON.parse(body); }
                catch (e) { return reject(new Error('Open-Meteo returned invalid JSON: ' + e.message)); }
                const cur = json && json.current;
                if (!cur || cur.temperature_2m == null) {
                    return reject(new Error('Open-Meteo response missing current.temperature_2m'));
                }
                resolve({
                    temp: Number(cur.temperature_2m),
                    humidity: cur.relative_humidity_2m != null ? Number(cur.relative_humidity_2m) : null,
                    pressure: cur.surface_pressure != null ? Number(cur.surface_pressure) : null,
                });
            });
        });
        req.on('timeout', function () { req.destroy(new Error('Open-Meteo request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

function fmt(n) {
    return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

// Fetch current weather for (lat,lon) and set temperature (+humidity/pressure when
// present) on the device sensors via the console. Returns the applied values.
// Throws on fetch/console error — the caller (frontend) keeps the last value on error.
async function applyWeather(serial, latitude, longitude) {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const w = await fetchOpenMeteo(lat, lon);

    const cmds = ['sensor set temperature ' + fmt(w.temp)];
    if (w.humidity != null && Number.isFinite(w.humidity)) cmds.push('sensor set humidity ' + fmt(w.humidity));
    if (w.pressure != null && Number.isFinite(w.pressure)) cmds.push('sensor set pressure ' + fmt(w.pressure));

    await consoleExec(serial, cmds, { timeoutMs: CONSOLE_TIMEOUT_MS });

    log.info({ serial, lat, lon, temp: w.temp, humidity: w.humidity, pressure: w.pressure }, 'Applied weather from location');

    return {
        serial,
        latitude: lat,
        longitude: lon,
        temp: w.temp,
        humidity: w.humidity,
        pressure: w.pressure,
        appliedAt: new Date().toISOString(),
    };
}

module.exports = {
    validateCoordinates,
    fetchOpenMeteo,
    applyWeather,
};
