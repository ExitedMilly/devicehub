'use strict';

// ===========================================================================
// APP-LEVEL ONLY — proven at Stage-0. Read this before touching the feature.
// ---------------------------------------------------------------------------
// Injecting a location's real BSSIDs into getScanResults() does NOT fool the
// system / fused geolocation: GMS reads Wi-Fi through the low-level WifiScanner
// (bypassing our getScanResults), and GPS dominates the fused fix. Bench proof:
// 15 real Moscow BSSIDs injected, GMS observed for 90s, the fused location did
// NOT move. This ONLY affects apps that call WifiManager.getScanResults()
// DIRECTLY (e.g. antifraud doing a GPS↔Wi-Fi cross-check). It does not change the
// device's real/reported location. Keep this limitation in the UI + docs.
// ---------------------------------------------------------------------------
// Source: Apple's crowdsourced Wi-Fi location tiles. gspe85-ssl.ls.apple.com/
// wifi_request_tile returns ALL access points of a z13 slippy tile (identified by
// X-tilekey = morton-interleaved tile coords) with no seed BSSID — proven at
// Stage-0 (Moscow centre → 2214 real {bssid,lat,lon}). Ported from the Stage-0
// Python client (tilekey algorithm + tile wire format verified against live data).
// ===========================================================================

const https = require('https');
const zlib = require('zlib');
const { setLocationFakeScan, clearLocationFakeScan } = require('./fake-scan');
const log = require('../log').getLogger('domain/wifi-geo');

const APPLE_TILE_HOST = 'gspe85-ssl.ls.apple.com';
const APPLE_TILE_PATH = '/wifi_request_tile';
const REQUEST_TIMEOUT_MS = 20000;
const TOP_N = 18;                 // nearest APs to inject (a real phone sees ~10–30)
const FREQS = [2412, 2437, 2462, 5180, 5745];

// ----- tile key: slippy z13 → morton interleave (ported from Stage-0 wloc.py) -----
function tileKey(lat, lon, level) {
    level = level || 13;
    const n = 2 ** level;
    const xt = Math.floor(((lon + 180) / 360) * n);
    const yt = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    let key = 2 ** (2 * level);
    let col = xt, row = yt;
    for (let i = 0; i < level; i++) {
        if (col & 1) key += 2 ** (2 * i);
        if (row & 1) key += 2 ** (2 * i + 1);
        col = Math.floor(col / 2);
        row = Math.floor(row / 2);
    }
    return key;
}

// ----- minimal protobuf wire reader (ported from wloc.py _read_varint/_parse) -----
// Uses float math for varints so a 48-bit BSSID (< 2^53) survives intact.
function readVarint(buf, i) {
    let result = 0, shift = 0, byte;
    do {
        byte = buf[i++];
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return [result, i];
}

function parseFields(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        let key;
        [key, i] = readVarint(buf, i);
        const field = Math.floor(key / 8); // key >> 3
        const wt = key & 7;
        if (wt === 0) { let v; [v, i] = readVarint(buf, i); out.push([field, 0, v]); }
        else if (wt === 2) { let len; [len, i] = readVarint(buf, i); out.push([field, 2, buf.slice(i, i + len)]); i += len; }
        else if (wt === 5) { out.push([field, 5, buf.slice(i, i + 4)]); i += 4; }
        else if (wt === 1) { out.push([field, 1, buf.slice(i, i + 8)]); i += 8; }
        else throw new Error('unknown wire type ' + wt);
    }
    return out;
}

// 48-bit MAC in the low 6 bytes of a big-endian 64-bit int (== struct.pack('>Q')[2:]).
function macFromInt(n) {
    const bytes = [];
    for (let b = 5; b >= 0; b--) bytes.push(Math.floor(n / 2 ** (8 * b)) % 256);
    return bytes.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

// Tile response layout (verified live): top → field 3 (region) → field 2 (device) →
// { field 5 = bssid varint, field 6 = location { field 1 = lat_i32, field 2 = lon_i32 } }.
// lat/lon are little-endian signed int32, scaled by 1e-7.
function decodeTile(buf) {
    const aps = [];
    for (const [f, wt, region] of parseFields(buf)) {
        if (f !== 3 || wt !== 2) continue;
        for (const [df, dw, dev] of parseFields(region)) {
            if (df !== 2 || dw !== 2) continue;
            let bssid = null, latI = null, lonI = null;
            for (const [xf, xw, xv] of parseFields(dev)) {
                if (xf === 5) bssid = macFromInt(xv);
                if (xf === 6 && xw === 2) {
                    for (const [tf, tw, tv] of parseFields(xv)) {
                        if (tf === 1 && tw === 5) latI = tv.readInt32LE(0);
                        if (tf === 2 && tw === 5) lonI = tv.readInt32LE(0);
                    }
                }
            }
            if (bssid && latI != null && lonI != null) {
                aps.push({ bssid, lat: latI * 1e-7, lon: lonI * 1e-7 });
            }
        }
    }
    return aps;
}

function fetchTile(key) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: APPLE_TILE_HOST,
            path: APPLE_TILE_PATH,
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip',
                'X-tilekey': String(key),
                'User-Agent': 'geod/1 CFNetwork/1496.0.7 Darwin/23.5.0',
                'Accept-Language': 'en-US,en-GB;q=0.9,en;q=0.8',
                'X-os-version': '17.5.21F79',
            },
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let body = Buffer.concat(chunks);
                if (res.statusCode !== 200) {
                    return reject(new Error('Apple tile HTTP ' + res.statusCode + ' (' + body.length + ' bytes)'));
                }
                // Apple gzips the tile; Node's https (unlike Python requests) does NOT
                // auto-decompress, so do it here based on Content-Encoding.
                const enc = String(res.headers['content-encoding'] || '').toLowerCase();
                try {
                    if (enc === 'gzip') body = zlib.gunzipSync(body);
                    else if (enc === 'deflate') body = zlib.inflateSync(body);
                    else if (enc === 'br') body = zlib.brotliDecompressSync(body);
                } catch (e) {
                    return reject(new Error('Apple tile decompress failed: ' + e.message));
                }
                resolve(body);
            });
        });
        req.on('timeout', () => req.destroy(new Error('Apple tile request timed out')));
        req.on('error', reject);
        req.end();
    });
}

// Fetch every AP of the z13 tile containing (lat,lon). Rejects on network/HTTP error.
async function queryTile(lat, lon) {
    const key = tileKey(lat, lon);
    const body = await fetchTile(key);
    const aps = decodeTile(body);
    log.info({ lat, lon, tilekey: key, bytes: body.length, aps: aps.length }, 'Apple WLOC tile fetched');
    return aps;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Log-distance path loss → a plausible urban RSSI (nearer = stronger), clamped.
function rssiForDistance(d) {
    const rssi = Math.round(-43 - 22 * Math.log10(Math.max(1, d / 3)));
    return Math.max(-92, Math.min(-43, rssi));
}

function validateCoordinates(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('latitude must be between -90 and 90');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('longitude must be between -180 and 180');
    return { lat, lon };
}

// Query the tile, take the TOP_N nearest APs, and inject them into getScanResults()
// via the fake-scan 'location' source (merged with any manual networks). The tile
// carries only BSSIDs (the location fingerprint), not SSIDs, so SSIDs are placeholders.
async function applyBssidSync(serial, latitude, longitude) {
    const { lat, lon } = validateCoordinates(latitude, longitude);
    const aps = await queryTile(lat, lon);

    if (!aps.length) {
        // Rural/empty tile — remove our injected networks rather than fake nothing.
        await clearLocationFakeScan(serial);
        return { serial, latitude: lat, longitude: lon, count: 0, total: 0 };
    }

    const nearest = aps
        .map((ap) => ({ ...ap, d: haversineMeters(lat, lon, ap.lat, ap.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, TOP_N);

    const networks = nearest.map((ap, i) => ({
        ssid: 'AP-' + ap.bssid.replace(/:/g, '').slice(-6),
        bssid: ap.bssid,
        security: 'wpa2',
        freq: FREQS[i % FREQS.length],
        signalDbm: rssiForDistance(ap.d),
    }));

    await setLocationFakeScan(serial, networks);
    log.info({ serial, injected: networks.length, total: aps.length, nearestM: Math.round(nearest[0].d) }, 'BSSID-sync applied from location');
    return { serial, latitude: lat, longitude: lon, count: networks.length, total: aps.length, nearestM: Math.round(nearest[0].d) };
}

async function clearBssidSync(serial) {
    await clearLocationFakeScan(serial);
    return { serial, count: 0 };
}

module.exports = {
    tileKey,
    queryTile,
    decodeTile,
    macFromInt,
    applyBssidSync,
    clearBssidSync,
};
