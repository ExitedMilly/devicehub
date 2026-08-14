'use strict';

// OpenAPI 3.1 definition for the manager's REST API.
//
// Split of responsibility:
//   - THIS file owns the base document: info, servers, tags, securitySchemes, and every
//     reusable component (schemas + responses). Kept as a plain JS object so there is no
//     YAML-indentation risk and the shapes are greppable.
//   - The per-path operations live as `@openapi` JSDoc blocks above the handlers in
//     http/routes-*.js, and only ever $ref these components.
//
// swagger-jsdoc merges the two.
//
// NOTE: the manager does not serve this document. It is compiled at frontend build time by
// ui/tools/generate-openapi.mjs, which requires this file, scans the route annotations and
// writes ui/public/api-docs/openapi.json into the UI's static assets. The page then lives
// with the rest of the frontend (/api-docs/) instead of on each manager port, which is why
// nothing here depends on express or swagger-ui-express any more. This file and the JSDoc
// blocks above the handlers remain the single source of truth for the API contract.

const path = require('path');
const { MANAGER_PORT, INSTANCE_SERIAL } = require('../config');

const SERIAL_EXAMPLE = INSTANCE_SERIAL || 'emulator-test3:5555';

// ---------------------------------------------------------------------------
// Description shown at the top of the page. Documents the things that are NOT
// expressible as paths: SINGLE_MODE, auth, and the WebSocket channels.
// ---------------------------------------------------------------------------
const DESCRIPTION = `
REST API of the OrchID **audio-capture-manager** — one manager process per emulator.

### This page is reference only
Request execution is disabled: there are no Try-it-out or Execute controls, and nothing on this
page sends anything to a device. It documents the contract — paths, payloads, status codes,
timings and side effects — and nothing more.

To actually call the API, take the machine-readable document from
[\`/api/openapi.json\`](openapi.json) and drive it from a real client: import it into Postman or
Insomnia, generate a client, or hand it to curl. That export is the supported way to experiment.

### SINGLE_MODE
Each manager owns exactly one emulator, identified by \`INSTANCE_SERIAL\`
(currently \`${SERIAL_EXAMPLE}\`). The \`serial\` path parameter **must equal that value**;
any other serial is rejected with \`403 { "error": "Serial not allowed in single mode",
"expected": "<INSTANCE_SERIAL>" }\`. The serial contains a colon; both the raw form
(\`emulator-test3:5555\`) and the percent-encoded form (\`emulator-test3%3A5555\`) are accepted
and route correctly through nginx.

### Authentication
Every endpoint except \`/health\` and \`/metrics\` requires a Bearer JWS signed with the
shared \`STF_SECRET\`, and — when \`AUTH_REQUIRED=1\` — an ownership check against DeviceHub's
API for serial-scoped paths. Send it as \`Authorization: Bearer <token>\`; the \`bearerAuth\`
scheme below describes it for client generators. Auth runs *before* routing, so an unknown path
and an unauthorized call both answer 401 when \`AUTH_REQUIRED=1\`; a 401 therefore does not prove
that a route exists.

### Operations that change a live device
Most \`POST\`/\`DELETE\` operations act on a running Android emulator. Those are marked
**Live device** in their description, together with how long they block and any side effect that
is not obvious from the name. Read those before wiring a client: several operations hold the
connection for seconds (a cell change restarts the radio, roughly 6-7 s) or minutes (backup and
restore), and client timeouts have to be sized for them.

### Not covered here (WebSocket, not REST)
The manager also serves WebSocket channels on the same port. They carry binary media and
signalling, so they are outside OpenAPI:
\`/audio/{serial}\` (WebM/Opus out), \`/mic-rtc/{serial}\` (WebRTC signalling),
\`/mic-state/{serial}\` (listening/idle events), \`/camera/{serial}\` (WebRTC signalling),
\`/camera-state/{serial}\`, \`/file-video/{serial}\` (raw YUV420 in),
\`/file-audio/{serial}\` (raw PCM in).
Close codes: \`4000\` invalid path, \`4001\` auth denied, \`4002\` serial not allowed,
\`4009\` already in use, \`4010\` gRPC proto not loaded, \`4409\` busy (WebRTC session),
\`4410\` busy (another file injection). See \`ws/server.js\` and \`ws/auth-middleware.js\`.
The device screen stream (minicap) and the socket.io control channel belong to the
DeviceHub stack, not to this manager.
`.trim();

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------
const schemas = {
    // ---- errors -----------------------------------------------------------
    ErrorWithReason: {
        type: 'object',
        description: 'Auth / ownership rejections produced by the middleware.',
        properties: {
            error: { type: 'string', example: 'unauthorized' },
            reason: { type: 'string', example: 'no token' },
        },
        required: ['error'],
    },
    ErrorOkFalse: {
        type: 'object',
        description: 'Domain failure raised by a handler (the common shape).',
        properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string', example: 'cid must be an integer between 0 and 268435455' },
        },
        required: ['ok', 'error'],
    },
    ErrorOkFalseReason: {
        type: 'object',
        description: 'Used only by the file-inject preflight, which reports `reason`, not `error`.',
        properties: {
            ok: { type: 'boolean', const: false },
            reason: { type: 'string', example: 'camera busy (WebRTC session active)' },
        },
        required: ['ok', 'reason'],
    },
    SingleModeError: {
        type: 'object',
        description: 'SINGLE_MODE rejection: the serial in the path is not this instance.',
        properties: {
            error: { type: 'string', const: 'Serial not allowed in single mode' },
            expected: { type: 'string', example: SERIAL_EXAMPLE },
        },
        required: ['error', 'expected'],
    },
    ErrorResponse: {
        description: 'Union of the error shapes this API actually returns.',
        oneOf: [
            { $ref: '#/components/schemas/ErrorWithReason' },
            { $ref: '#/components/schemas/ErrorOkFalse' },
            { $ref: '#/components/schemas/ErrorOkFalseReason' },
        ],
    },

    // ---- system -----------------------------------------------------------
    HealthStatus: {
        type: 'object',
        properties: {
            status: { type: 'string', const: 'ok' },
            instances: { type: 'integer', example: 1 },
            gpsSessions: { type: 'integer', example: 0 },
            poseStates: { type: 'integer', example: 1 },
            lightStates: { type: 'integer', example: 1 },
            autoDiscovery: { type: 'boolean', example: true },
            knownQemuInputs: { type: 'integer', example: 0 },
        },
    },
    CaptureStatus: {
        type: 'object',
        description: 'Audio-capture, microphone and camera state, keyed by serial.',
        properties: {
            capture: { type: 'object', additionalProperties: true },
            micStates: {
                type: 'object',
                additionalProperties: { type: 'string', enum: ['listening', 'idle', 'unknown'] },
                example: { [SERIAL_EXAMPLE]: 'idle' },
            },
            camera: { type: 'object', additionalProperties: true },
            cameraStates: { type: 'object', additionalProperties: { type: 'string' } },
        },
    },
    CaptureStartRequest: {
        type: 'object',
        properties: {
            sinkIndex: { type: 'integer', description: 'PulseAudio sink index (emu_audio_<N>).', example: 4 },
        },
        required: ['sinkIndex'],
    },
    CaptureActionResult: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['started', 'already_running', 'stopped'] },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            sinkName: { type: 'string', example: 'emu_audio_4' },
            state: { type: 'string', example: 'running' },
            clients: { type: 'integer', example: 0 },
            ffmpegPid: { type: ['integer', 'null'], example: 412 },
            hasInitSegment: { type: 'boolean', example: true },
        },
    },

    // ---- cell -------------------------------------------------------------
    Operator: {
        type: 'object',
        description: 'Operator pinned to the instance by the op-shim; read-only at runtime.',
        properties: {
            mcc: { type: 'string', example: '250' },
            mnc: { type: 'string', example: '01' },
            name: { type: 'string', example: 'MTS' },
            plmn: { type: 'string', example: '25001' },
            locked: { type: 'boolean', const: true },
        },
    },
    ServingCell: {
        type: 'object',
        description: 'Live serving cell read back from `dumpsys telephony.registry` (best effort).',
        properties: {
            cid: { type: ['integer', 'null'], example: 355851 },
            lac: { type: ['integer', 'null'], example: 17771 },
            type: { type: ['string', 'null'], description: 'CellIdentity flavour.', example: 'Lte' },
        },
    },
    CellTowerStatus: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            applied: { type: 'boolean', description: 'true when any spoof property is set.', example: true },
            cid: { type: 'string', example: '355851' },
            lac: { type: 'string', example: '17771' },
            tac: { type: 'string', example: '17771' },
            rat: { type: 'string', description: 'RADIO_TECH_* int as string: 14 LTE, 11 UMTS, 16 GSM, 20 NR.', example: '14' },
            neighbors: { type: 'string', example: '' },
            operator: { $ref: '#/components/schemas/Operator' },
            serving: { $ref: '#/components/schemas/ServingCell' },
        },
    },
    CellTowerApplyRequest: {
        type: 'object',
        properties: {
            cid: { type: 'integer', minimum: 0, maximum: 268435455, example: 355851 },
            lac: { type: 'integer', minimum: 0, maximum: 65535, example: 17771 },
            tac: { type: 'integer', minimum: 0, maximum: 65535, description: 'Optional; defaults to `lac`.', example: 17771 },
            rat: { type: 'string', enum: ['gsm', 'umts', 'lte', 'nr'], example: 'lte' },
            neighbors: {
                type: 'string',
                description: 'Up to 8 `cid:lac:rssi` triplets, comma separated. rssi is asu 0..31. Applied on the NEXT full reboot only.',
                example: '355852:17771:20,355853:17771:15',
            },
            mcc: { type: 'string', description: 'Optional. Rejected if it differs from the pinned operator.', example: '250' },
            mnc: { type: 'string', description: 'Optional. Rejected if it differs from the pinned operator.', example: '01' },
        },
        required: ['cid', 'lac', 'rat'],
    },
    CellSyncRequest: {
        type: 'object',
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90, example: 55.751244 },
            longitude: { type: 'number', minimum: -180, maximum: 180, example: 37.618423 },
        },
        required: ['latitude', 'longitude'],
    },
    CellSyncResult: {
        type: 'object',
        description:
            'Result of a GPS→tower sync. `changed:false` is a normal outcome, not an error: ' +
            'the backend compares the nearest tower with the current CID and skips the ~7 s ' +
            'RIL restart when they match (same-cid gate).',
        properties: {
            ok: { type: 'boolean', const: true },
            changed: { type: 'boolean', example: true },
            reason: {
                type: 'string',
                description: 'Present only when `changed:false`.',
                enum: ['already on nearest tower', 'no tower found near location'],
            },
            cid: { type: 'integer', example: 355851 },
            distanceM: { type: 'integer', description: 'Distance from the coordinates to the tower.', example: 230 },
            towerLat: { type: 'number', example: 55.7531 },
            towerLon: { type: 'number', example: 37.6205 },
            operator: { type: 'string', example: 'MTS' },
            serving: { $ref: '#/components/schemas/ServingCell' },
        },
    },

    // ---- gps / walk -------------------------------------------------------
    GpsApplyRequest: {
        type: 'object',
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90, example: 55.751244 },
            longitude: { type: 'number', minimum: -180, maximum: 180, example: 37.618423 },
            provider: { type: 'string', enum: ['gps', 'fused', 'network', 'passive'], default: 'gps' },
            keepAlive: {
                type: 'boolean',
                description: 'Re-apply on a timer. Without it Android marks the mock location stale after ~20 s.',
                default: false,
            },
            intervalMs: { type: 'integer', minimum: 5000, description: 'Keepalive period; below 5000 falls back to the default.', example: 20000 },
        },
        required: ['latitude', 'longitude'],
    },
    GpsApplyResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            provider: { type: 'string', example: 'gps' },
            latitude: { type: 'number', example: 55.751244 },
            longitude: { type: 'number', example: 37.618423 },
            keepAlive: { type: 'boolean', example: true },
            intervalMs: { type: ['integer', 'null'], example: 20000 },
            startedAt: { type: 'string', format: 'date-time' },
        },
    },
    GpsStopResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            stopped: { type: 'boolean', description: 'false when no keepalive was running.', example: true },
        },
    },
    GpsSessionsStatus: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            sessions: { type: 'object', additionalProperties: true },
        },
    },
    Waypoint: {
        type: 'object',
        description:
            'Route point. NOTE the field names differ from the GPS endpoints: the walk simulator ' +
            'takes `lat`/`lon` (see domain/walk-simulator.js), while POST /gps/{serial} takes ' +
            '`latitude`/`longitude`.',
        properties: {
            lat: { type: 'number', example: 55.751244 },
            lon: { type: 'number', example: 37.618423 },
        },
        required: ['lat', 'lon'],
    },
    WalkStartRequest: {
        type: 'object',
        description: 'Give either `waypoints` (2 or more) or `from`+`to`. Route comes from the public OSRM demo server.',
        properties: {
            waypoints: { type: 'array', minItems: 2, items: { $ref: '#/components/schemas/Waypoint' } },
            from: { $ref: '#/components/schemas/Waypoint' },
            to: { $ref: '#/components/schemas/Waypoint' },
            profile: { type: 'string', enum: ['foot', 'bike', 'driving'], default: 'foot' },
            speed: {
                oneOf: [
                    { type: 'number', description: 'Metres per second, 0 < x < 100.' },
                    { type: 'string', enum: ['walking', 'jogging', 'running', 'cycling', 'driving'] },
                ],
                example: 'walking',
            },
            jitter: { type: 'boolean', default: false },
            jitterMeters: { type: 'number', maximum: 1, description: 'Capped at 1 m.' },
            speedVariance: { type: 'boolean', default: true },
            keepAliveAfterFinish: { type: 'boolean', default: true },
            pauseAccelOnWalkPause: { type: 'boolean', default: false },
        },
    },
    WalkStatus: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['idle', 'running', 'paused', 'finished'], example: 'running' },
            profile: { type: 'string', example: 'foot' },
            nominalSpeed: { type: 'number', example: 1.4 },
            currentSpeed: { type: 'number', example: 1.38 },
            totalDistanceM: { type: 'number', example: 1840.2 },
            coveredDistanceM: { type: 'number', example: 412.7 },
            progress: { type: 'number', description: 'Fraction 0..1, 4 decimal places.', example: 0.2243 },
            etaSeconds: { type: 'number', example: 1019 },
            currentPoint: { $ref: '#/components/schemas/Waypoint' },
            targetPoint: { $ref: '#/components/schemas/Waypoint' },
            lastError: { type: ['string', 'null'] },
        },
    },
    WalkActionResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            status: { $ref: '#/components/schemas/WalkStatus' },
            paused: { type: 'boolean' },
            resumed: { type: 'boolean' },
            stopped: { type: 'boolean' },
        },
    },

    // ---- sensors ----------------------------------------------------------
    PoseRequest: {
        type: 'object',
        properties: {
            pitch: { type: 'number', minimum: -180, maximum: 180, example: 0 },
            yaw: { type: 'number', minimum: -180, maximum: 180, example: 0 },
            roll: { type: 'number', minimum: -180, maximum: 180, example: 90 },
        },
        required: ['pitch', 'yaw', 'roll'],
    },
    PoseResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            pitch: { type: 'number' }, yaw: { type: 'number' }, roll: { type: 'number' },
            appliedAt: { type: 'string', format: 'date-time' },
            rotation: { type: 'array', items: { type: 'number' } },
            acceleration: { type: 'array', items: { type: 'number' } },
            orientation: { type: 'array', items: { type: 'number' } },
        },
    },
    PoseScenarioListResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            scenarios: {
                type: 'object',
                additionalProperties: {
                    type: 'object',
                    properties: { label: { type: 'string' }, base: { type: 'object', additionalProperties: true } },
                },
                example: { walking: { label: 'Walking (in pocket)', base: { pitch: 75, yaw: 0, roll: 0 } } },
            },
            tickHz: { type: 'integer', example: 10 },
        },
    },
    PoseScenarioStartRequest: {
        type: 'object',
        properties: {
            scenario: { type: 'string', enum: ['walking', 'cycling', 'driving'], example: 'walking' },
        },
        required: ['scenario'],
    },
    PoseScenarioResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            status: { type: 'object', additionalProperties: true },
            paused: { type: 'boolean' }, resumed: { type: 'boolean' }, stopped: { type: 'boolean' },
        },
    },
    PoseStatesStatus: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true }, poses: { type: 'object', additionalProperties: true } },
    },
    LightRequest: {
        type: 'object',
        properties: { lux: { type: 'number', minimum: 0, example: 300 } },
        required: ['lux'],
    },
    LightResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            lux: { type: 'number', example: 300 },
            appliedAt: { type: 'string', format: 'date-time' },
            appliedVia: { type: 'string', enum: ['physicalModel', 'adbConsole'], description: 'gRPC first; falls back to `adb emu sensor set` on a readback mismatch.' },
            physicalLux: { type: ['number', 'null'] },
            sensorLux: { type: ['number', 'null'] },
            fallbackReason: { type: ['string', 'null'] },
        },
    },
    LightStatesStatus: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true }, lights: { type: 'object', additionalProperties: true } },
    },
    TemperatureRequest: {
        type: 'object',
        properties: { celsius: { type: 'number', minimum: -50, maximum: 100, example: 25 } },
        required: ['celsius'],
    },
    TemperatureResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            celsius: { type: 'number', example: 25 },
            appliedAt: { type: 'string', format: 'date-time' },
            appliedVia: { type: 'string', const: 'console' },
            sensorTemp: { type: ['number', 'null'], description: 'Value read back from the sensor.', example: 25 },
        },
    },
    SensorNoiseRequest: {
        type: 'object',
        properties: {
            enabled: { type: 'boolean', example: true },
            owned: {
                type: 'array',
                items: { type: 'string', enum: ['light', 'pose', 'temperature', 'humidity', 'pressure'] },
                description: 'Resources currently held by an operblock. Noise skips the sensors they drive.',
                example: ['light'],
            },
        },
        required: ['enabled'],
    },
    SensorNoiseState: {
        type: 'object',
        description:
            'When no loop is running the body is just `{ ok: true, active: false }` — the ' +
            'remaining fields are present only while it is active.',
        properties: {
            ok: { type: 'boolean', const: true },
            active: { type: 'boolean', example: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            owned: {
                type: 'array',
                items: { type: 'string' },
                description: 'Resources an operblock holds; their sensors are left alone.',
                example: ['light'],
            },
            skipped: {
                type: 'array',
                items: { type: 'string' },
                description: 'Sensor names skipped this tick, derived from `owned`.',
                example: ['light'],
            },
            sensors: { type: 'integer', description: 'How many sensors the loop drives in total.', example: 12 },
            tickMs: { type: 'integer', example: 350 },
            startedAt: { type: ['string', 'null'], format: 'date-time' },
            lastTickAt: { type: ['string', 'null'], format: 'date-time' },
            lastError: { type: ['string', 'null'] },
        },
    },
    WeatherRequest: {
        type: 'object',
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90, example: 55.751244 },
            longitude: { type: 'number', minimum: -180, maximum: 180, example: 37.618423 },
        },
        required: ['latitude', 'longitude'],
    },
    WeatherResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            latitude: { type: 'number' }, longitude: { type: 'number' },
            temp: { type: 'number', description: 'Degrees Celsius.', example: 18.4 },
            humidity: { type: ['number', 'null'], description: 'Percent.', example: 62 },
            pressure: { type: ['number', 'null'], description: 'hPa.', example: 1011.3 },
            appliedAt: { type: 'string', format: 'date-time' },
        },
    },

    // ---- network ----------------------------------------------------------
    NetworkStatus: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            voice: { type: 'string', example: 'home' },
            data: { type: 'string', example: 'home' },
            wifi: { type: 'boolean', example: true },
            airplane: { type: 'boolean', example: false },
        },
    },
    NetworkApplyRequest: {
        type: 'object',
        description: 'Every field is optional; only the ones present are applied, in the order listed.',
        properties: {
            signalProfile: { type: 'integer', minimum: 0, maximum: 4, description: 'Perceived bars; mapped to RSSI [0,6,12,18,28].', example: 4 },
            rssi: { type: 'integer', minimum: 0, maximum: 31, example: 28 },
            ber: { type: 'integer', minimum: 0, maximum: 7, example: 0 },
            networkType: { type: 'string', enum: ['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo', 'full'], example: 'lte' },
            registration: { type: 'string', enum: ['unregistered', 'home', 'roaming', 'searching', 'denied'], example: 'home' },
            wifi: { type: 'boolean', example: true },
            airplane: { type: 'boolean', example: false },
        },
    },
    ProxyState: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            enabled: { type: 'boolean', example: true },
            host: { type: ['string', 'null'], example: '172.20.0.1' },
            port: { type: ['integer', 'null'], example: 8888 },
            raw: { type: ['string', 'null'], example: '172.20.0.1:8888' },
        },
    },
    ProxyRequest: {
        type: 'object',
        properties: {
            host: { type: 'string', example: '172.20.0.1' },
            port: { type: 'integer', minimum: 1, maximum: 65535, example: 8888 },
        },
        required: ['host', 'port'],
    },
    ProxyHostAddress: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            hostAddress: {
                type: ['string', 'null'],
                description: 'Docker-network gateway, i.e. the docker host. Note 10.0.2.2 does NOT work here.',
                example: '172.20.0.1',
            },
        },
    },
    FakeScanNetwork: {
        type: 'object',
        properties: {
            ssid: { type: 'string', minLength: 1, maxLength: 32, description: 'No whitespace.', example: 'OrchidNet' },
            security: { type: 'string', enum: ['open', 'wpa2', 'wpa3'], default: 'wpa2' },
            signalDbm: { type: 'integer', minimum: -100, maximum: -30, example: -55 },
            freq: { type: 'integer', minimum: 2400, maximum: 6000, default: 2412 },
            bssid: { type: 'string', pattern: '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$', example: '02:00:00:00:00:01' },
        },
        required: ['ssid'],
    },
    FakeScanRequest: {
        type: 'object',
        properties: { networks: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/FakeScanNetwork' } } },
        required: ['networks'],
    },
    FakeScanState: {
        type: 'object',
        description: 'Manual source only. Location-synced BSSIDs are merged on the device but not shown here.',
        properties: {
            ok: { type: 'boolean', const: true },
            faking: { type: 'boolean', example: true },
            networks: { type: 'array', items: { $ref: '#/components/schemas/FakeScanNetwork' } },
        },
    },
    WifiGeoRequest: {
        type: 'object',
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90, example: 55.751244 },
            longitude: { type: 'number', minimum: -180, maximum: 180, example: 37.618423 },
        },
        required: ['latitude', 'longitude'],
    },
    WifiGeoResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            latitude: { type: 'number' }, longitude: { type: 'number' },
            count: { type: 'integer', description: 'Injected access points (nearest 18).', example: 18 },
            total: { type: 'integer', description: 'Access points the tile returned.', example: 2214 },
            nearestM: { type: 'number', example: 37.2 },
        },
    },
    BluetoothState: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            enabled: { type: 'boolean', example: true },
            state: { type: 'string', enum: ['ON', 'OFF', 'TURNING_ON', 'TURNING_OFF', 'BLE_ON', 'BLE_TURNING_ON', 'BLE_TURNING_OFF'], example: 'ON' },
        },
    },
    BluetoothRequest: {
        type: 'object',
        properties: { enabled: { type: 'boolean', example: true } },
        required: ['enabled'],
    },
    BleBeacon: {
        type: 'object',
        properties: {
            id: { type: 'integer', description: 'netsim chip id; use it to delete the beacon.', example: 3 },
            name: { type: 'string', example: 'OrchidBeacon' },
            address: { type: 'string', example: 'be:ac:0b:0c:0d:0e' },
            scannable: { type: 'boolean' },
            includeDeviceName: { type: 'boolean' },
            advertiseMode: { type: 'string', example: 'LOW_LATENCY' },
            intervalMs: { type: ['integer', 'null'] },
            txPowerLevel: { type: ['string', 'null'], example: 'HIGH' },
            dbm: { type: ['integer', 'null'] },
            manufacturerData: { type: ['string', 'null'], description: 'Hex.', example: '00ff01020304' },
            services: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
    },
    BleBeaconRequest: {
        type: 'object',
        properties: {
            name: { type: 'string', example: 'OrchidBeacon' },
            mac: { type: 'string', pattern: '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$', example: 'be:ac:0b:0c:0d:0e' },
            manufacturer_data: { type: 'string', description: 'Even-length hex.', example: '00ff01020304' },
            service_uuid: { type: 'string', example: '0000fe2c-0000-1000-8000-00805f9b34fb' },
            service_data: { type: 'string', description: 'Even-length hex; requires service_uuid.', example: 'aabbcc' },
            tx_power: { oneOf: [{ type: 'string', enum: ['ultra-low', 'low', 'medium', 'high'] }, { type: 'integer', minimum: -127, maximum: 127 }], example: 'high' },
            interval: { oneOf: [{ type: 'string', enum: ['low-power', 'balanced', 'low-latency'] }, { type: 'integer', minimum: 1 }], example: 'low-latency' },
            include_device_name: { type: 'boolean', default: true },
            scannable: { type: 'boolean', default: true },
        },
        required: ['name'],
    },
    BleBeaconList: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            beacons: { type: 'array', items: { $ref: '#/components/schemas/BleBeacon' } },
        },
    },

    // ---- device -----------------------------------------------------------
    BatteryState: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            capacity: { type: ['integer', 'null'], description: 'Percent.', example: 77 },
            charging: { type: 'boolean', example: false },
            status: { type: ['integer', 'null'], description: 'Raw Android status int (2 charging, 3 discharging).', example: 3 },
            health: { type: ['integer', 'null'], example: 2 },
        },
    },
    BatteryRequest: {
        type: 'object',
        properties: {
            level: { type: 'integer', minimum: 0, maximum: 100, example: 77 },
            charging: { type: 'boolean', example: false },
        },
    },
    PhoneNumberState: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            number: { type: ['string', 'null'], example: '79001234567' },
            raw: { type: ['string', 'null'], description: 'Raw parcel dump the number was parsed from.' },
        },
    },
    PhoneNumberRequest: {
        type: 'object',
        properties: {
            number: { type: 'string', pattern: '^\\d{7,15}$', description: 'Digits only, no leading +.', example: '79001234567' },
        },
        required: ['number'],
    },

    // ---- scenarios / schedule ---------------------------------------------
    ScenarioParam: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                description: 'One of the 17 runtime params in the constructor catalog.',
                enum: [
                    'battery.level', 'battery.charging', 'network.signal', 'network.speed',
                    'network.registration', 'network.wifi', 'network.airplane', 'gps.location',
                    'temperature.value', 'weather.on', 'light.lux', 'pose.preset',
                    'sensors.noise', 'bluetooth.on', 'proxy.config', 'phone.number', 'bssid.on',
                ],
                example: 'battery.level',
            },
            value: { description: 'Shape depends on `type` (number, boolean, string, {lat,lon} or {host,port}).', example: 77 },
        },
        required: ['type', 'value'],
    },
    Scenario: {
        type: 'object',
        properties: {
            id: { type: 'string', example: 'sc-m2x1p0-a7f3c1' },
            name: { type: 'string', example: 'Commute' },
            params: { type: 'array', items: { $ref: '#/components/schemas/ScenarioParam' } },
        },
        required: ['id', 'name', 'params'],
    },
    ScenarioList: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            scenarios: { type: 'array', items: { $ref: '#/components/schemas/Scenario' } },
        },
    },
    ScenarioApplyRequest: {
        type: 'object',
        description: 'Give `scenarioId` to apply a stored scenario, or `params` to apply an ad-hoc one. `params` wins.',
        properties: {
            scenarioId: { type: 'string', example: 'sc-m2x1p0-a7f3c1' },
            params: { type: 'array', items: { $ref: '#/components/schemas/ScenarioParam' } },
        },
    },
    ScenarioApplyResult: {
        type: 'object',
        description:
            'Returned with HTTP 200 even when `ok` is false: individual params can fail while the ' +
            'rest apply. Always inspect `failures`, not just the status code.',
        properties: {
            ok: { type: 'boolean', description: 'true only when `failures` is empty.', example: false },
            applied: { type: 'array', items: { type: 'string' }, example: ['gps.location', 'battery.level'] },
            failures: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { type: { type: 'string' }, error: { type: 'string' } },
                },
                example: [{ type: 'weather.on', error: 'weather needs a location — add "GPS location" to the scenario' }],
            },
        },
    },
    ScheduleEvent: {
        type: 'object',
        properties: {
            id: { type: 'string', example: 'ev-1' },
            time: { type: 'string', pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$', description: 'HH:MM in the offset carried by `tzOffsetMin`.', example: '09:00' },
            scenarioId: { type: 'string', example: 'sc-m2x1p0-a7f3c1' },
            repeat: { type: 'string', enum: ['daily', 'once'], default: 'daily' },
            maxJitterMin: { type: 'integer', minimum: 0, maximum: 720, description: 'Deterministic per-event, per-day jitter. Capped at 12 h.', example: 15 },
            enabled: { type: 'boolean', default: true },
        },
        required: ['id', 'time', 'scenarioId'],
    },
    Schedule: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            events: { type: 'array', items: { $ref: '#/components/schemas/ScheduleEvent' } },
            scheduleActive: { type: 'boolean', example: true },
            tzOffsetMin: {
                type: 'integer',
                minimum: -840,
                maximum: 840,
                description: 'Minutes east of UTC (browser `-getTimezoneOffset()`; MSK = 180). The container runs UTC, so the daemon needs this to resolve HH:MM.',
                example: 180,
            },
            fired: {
                type: 'object',
                additionalProperties: { type: 'string', format: 'date' },
                description: 'Daemon-owned anti-repeat state, read-only here: eventId -> YYYY-MM-DD.',
                example: { 'ev-1': '2026-07-31' },
            },
        },
    },
    ScheduleSaveRequest: {
        type: 'object',
        properties: {
            events: { type: 'array', items: { $ref: '#/components/schemas/ScheduleEvent' } },
            scheduleActive: { type: 'boolean', example: true },
            tzOffsetMin: { type: 'integer', example: 180 },
        },
        required: ['events'],
    },

    // ---- backup -----------------------------------------------------------
    BackupResult: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            result: {
                type: 'object',
                properties: {
                    serial: { type: 'string', example: SERIAL_EXAMPLE },
                    path: { type: 'string', example: '/backups/emulator-test3_5555.tar.gz' },
                    elapsedMs: { type: 'integer', example: 48213 },
                    savedAt: { type: 'string', format: 'date-time' },
                    sizeBytes: { type: 'integer', example: 154238976 },
                    sizeLabel: { type: 'string', example: '147.1 MB' },
                    packageCount: { type: 'integer', example: 12 },
                    errorCount: { type: 'integer', example: 0 },
                },
            },
        },
    },
    BackupStatus: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            serial: { type: 'string', example: SERIAL_EXAMPLE },
            status: {
                type: 'object',
                properties: {
                    exists: { type: 'boolean', example: true },
                    sizeBytes: { type: ['integer', 'null'] },
                    sizeLabel: { type: ['string', 'null'] },
                    createdAt: { type: ['string', 'null'], format: 'date-time' },
                    inProgress: { type: 'boolean', example: false },
                    operationKind: { type: ['string', 'null'], enum: ['backup', 'restore', null] },
                    progressStage: { type: ['string', 'null'], example: 'apks' },
                    progressDone: { type: ['integer', 'null'] },
                    progressTotal: { type: ['integer', 'null'] },
                    currentPackage: { type: ['string', 'null'] },
                },
            },
        },
    },
    BackupRestoreReport: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            report: {
                type: 'object',
                properties: {
                    serial: { type: 'string', example: SERIAL_EXAMPLE },
                    startedAt: { type: 'string', format: 'date-time' },
                    backupCreatedAt: { type: 'string', format: 'date-time' },
                    packagesInstalled: { type: 'integer', example: 12 },
                    packagesFailed: { type: 'integer', example: 0 },
                    sdcardRestored: { type: 'boolean', example: true },
                    errors: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    },

    // ---- media-state ------------------------------------------------------
    FileInjectPreflight: {
        type: 'object',
        properties: {
            ok: { type: 'boolean', const: true },
            width: { type: 'integer', example: 640 },
            height: { type: 'integer', example: 480 },
            fps: { type: 'integer', example: 25 },
            sampleRate: { type: 'integer', example: 48000 },
        },
    },
};

// ---------------------------------------------------------------------------
// Reusable responses. Every operation references these instead of inlining.
// ---------------------------------------------------------------------------
const responses = {
    BadRequest: {
        description:
            'Invalid input, malformed JSON body, or a body over 1 MiB ' +
            '(`Invalid JSON body` / `Request body too large`).',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorOkFalse' },
                example: { ok: false, error: 'Invalid JSON body' },
            },
        },
    },
    Unauthorized: {
        description:
            'Missing or invalid Bearer token (only enforced when `AUTH_REQUIRED=1`). ' +
            '`reason` is one of: `no token`, `invalid signature`, `malformed token`, `expired`, ' +
            '`no email in token`, `server misconfigured: no STF_SECRET`, `verify error: <msg>`.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorWithReason' },
                example: { error: 'unauthorized', reason: 'no token' },
            },
        },
    },
    Forbidden: {
        description: 'Authenticated, but the caller does not own this device in DeviceHub.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorWithReason' },
                example: { error: 'forbidden', reason: 'you do not own this device' },
            },
        },
    },
    ForbiddenSingleMode: {
        description:
            'The `serial` in the path is not the serial this manager owns. ' +
            'In SINGLE_MODE it must equal `INSTANCE_SERIAL`.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/SingleModeError' },
                example: { error: 'Serial not allowed in single mode', expected: SERIAL_EXAMPLE },
            },
        },
    },
    NotFoundRoute: {
        description: 'No such route, or the referenced object does not exist.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'not found' },
            },
        },
    },
    UpstreamFailure: {
        description:
            'An external dependency failed — the error comes from that service, not from the manager.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorOkFalse' },
                example: { ok: false, error: 'Open-Meteo HTTP 503: upstream unavailable' },
            },
        },
    },
    ServerError: {
        description: 'Unhandled failure on the manager side (file store, backup pipeline).',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorOkFalse' },
                example: { ok: false, error: 'EACCES: permission denied, open \'/backups/scenarios.json\'' },
            },
        },
    },
    OwnershipUnavailable: {
        description:
            'The DeviceHub ownership check could not be completed. The manager fails closed: ' +
            'when ownership cannot be established the request is refused rather than allowed.',
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ErrorWithReason' },
                example: { error: 'service unavailable', reason: 'ownership check failed' },
            },
        },
    },
};

// ---------------------------------------------------------------------------
// Base document
// ---------------------------------------------------------------------------
const definition = {
    openapi: '3.1.0',
    info: {
        title: 'OrchID audio-capture-manager API',
        version: require('../package.json').version,
        description: DESCRIPTION,
    },
    servers: [
        {
            // Port comes from MANAGER_PORT; host is a variable so the document stays correct
            // whichever machine the manager runs on.
            url: 'http://{host}:{port}/api',
            description:
                'Direct access to a single manager container, where the routes actually live. ' +
                'Every endpoint in this document is served here, including the ones without a ' +
                'serial in the path. Use this for host-local tooling and for talking to one ' +
                'instance on purpose.',
            variables: {
                host: { default: 'localhost', description: 'Host running this manager container.' },
                port: { default: String(MANAGER_PORT), description: 'MANAGER_PORT of this instance.' },
            },
        },
        {
            url: '/manager-api',
            description:
                'Canonical path used by real clients. The browser calls /manager-api/<x>/<serial>, ' +
                'and nginx rewrites it to /api/<x>/<serial> on the manager that owns that serial — ' +
                'so one origin fronts the whole fleet. Note nginx routes on the serial in the path: ' +
                'endpoints without one (health, metrics, */status, pose/scenario/list) are not ' +
                'reachable this way and must go through the direct server above.',
        },
    ],
    tags: [
        { name: 'system', description: 'Health, metrics and capture-process status.' },
        { name: 'cell', description: 'Serving-cell identity (CID/LAC/TAC/RAT) and GPS→tower sync. Needs the op-v4+ image.' },
        { name: 'gps', description: 'Mock location and route walk simulation.' },
        { name: 'sensors', description: 'Pose, light, temperature, weather and the realistic-sensor noise loop.' },
        { name: 'network', description: 'Cellular conditions, Wi-Fi scan results, proxy, Bluetooth and BLE beacons.' },
        { name: 'device', description: 'Battery and phone number.' },
        { name: 'scenarios', description: 'Stored constructor scenarios and the scheduling daemon.' },
        { name: 'backup', description: 'Logical backup and restore of installed apps and /sdcard.' },
        { name: 'media-state', description: 'Preflight for file injection into the virtual camera and microphone.' },
    ],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'JWS signed with the shared STF_SECRET. Obtain it from a DeviceHub session.',
            },
        },
        schemas,
        responses,
        parameters: {
            Serial: {
                name: 'serial',
                in: 'path',
                required: true,
                description:
                    'Emulator serial, `host:port`. In SINGLE_MODE it must equal this manager\'s ' +
                    'INSTANCE_SERIAL, otherwise the call is rejected with 403. The colon may be sent ' +
                    'raw or percent-encoded (`%3A`); both reach the handler, including through nginx, ' +
                    'and both are subject to the same per-device ownership check — the two encodings ' +
                    'are equivalent for every check the manager applies.\n\n' +
                    'A serial whose percent-encoding cannot be decoded (`%zz`, a lone `%`) is ' +
                    'rejected with 400 before any handler runs.',
                schema: { type: 'string', pattern: '^[^/]+:[0-9]+$' },
                example: SERIAL_EXAMPLE,
            },
            BeaconIdentifier: {
                name: 'identifier',
                in: 'path',
                required: true,
                description: 'netsim chip id (numeric) or the beacon device name.',
                schema: { type: 'string' },
                example: 'OrchidBeacon',
            },
        },
    },
    // Applied to every operation; /health and /metrics override it with `security: []`.
    security: [{ bearerAuth: [] }],
};

const options = {
    definition,
    // Operations are annotated next to their handlers. __dirname keeps this correct
    // both in the repo and at /app/http inside the image.
    apis: [path.join(__dirname, 'routes-*.js')],
};

module.exports = { options, definition };
