'use strict';

// Per-device constructor-scenario API (Type 1 storage moved off localStorage onto the
// backend file store, so the UI and the Type-2 daemon share one source of truth).
//   GET  /api/scenarios/<serial>          -> { ok, scenarios: [...] }
//   POST /api/scenarios/<serial>          -> replace the whole set (body = array)   -> { ok, scenarios }
//   POST /api/scenarios/<serial>/apply    -> apply one (body {scenarioId} or {params}) -> { ok, applied, failures }
// POST (not PUT) for mutations so no CORS Access-Control-Allow-Methods change is needed.

const scenariosStore = require('../domain/scenarios-store');
const { applyScenario } = require('../domain/scenario-apply');
const log = require('../log').getLogger('http/routes-scenarios');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /scenarios/{serial}:
 *   get:
 *     tags: [scenarios]
 *     operationId: listScenarios
 *     summary: List the saved constructor scenarios
 *     description: |
 *       Returns every scenario in the backend file store (`/backups/scenarios.json`), the single
 *       source of truth shared by the UI and the schedule daemon. Scenarios used to live in the
 *       browser's localStorage; they do not any more.
 *
 *       Each entry is `{ id, name, params }`, where `params` is a list of `{ type, value }` pairs
 *       drawn from the constructor catalog. Entries that do not match that shape are dropped on
 *       read, so a hand-edited or half-written file degrades to fewer scenarios rather than an
 *       error. A missing or corrupt file reads as an empty list, not a failure.
 *
 *       Read-only; safe to call at any time. The store is per-manager, not per-serial — the serial
 *       in the path selects the instance and is checked for access, but the returned set is the
 *       one set this manager owns.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: The current scenario set (possibly empty).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ScenarioList' }
 *             example:
 *               ok: true
 *               scenarios:
 *                 - id: sc-m2x1p0-a7f3c1
 *                   name: Commute
 *                   params:
 *                     - { type: gps.location, value: { lat: 55.751244, lon: 37.618423 } }
 *                     - { type: battery.level, value: 77 }
 *                     - { type: network.speed, value: lte }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500': { $ref: '#/components/responses/ServerError' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [scenarios]
 *     operationId: saveScenarios
 *     summary: Replace the whole scenario set
 *     description: |
 *       **Replaces the entire set**, it does not merge or append. Whatever array you send becomes
 *       the store's new contents, so anything omitted is deleted. The client owns the array and
 *       posts it whole, which keeps ids stable across edits.
 *
 *       Two body shapes are accepted: a bare JSON array of scenarios, or an object with a
 *       `scenarios` array. Anything else is a 400 — a body that is neither shape is rejected
 *       rather than treated as "empty", so a malformed request cannot silently wipe the set.
 *
 *       The set is sanitized before it is written: entries without a string `id`, a string `name`
 *       and a `params` array are dropped, and each param is reduced to `{ type, value }`. The
 *       response body is the sanitized set actually persisted, so compare it with what you sent if
 *       something you expected is missing. The write is atomic (temp file + rename), so a reader
 *       never observes a half-written file.
 *
 *       This only stores definitions. Nothing is applied to the device until
 *       `POST /scenarios/{serial}/apply` runs, or the schedule daemon fires an event.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: array
 *                 items: { $ref: '#/components/schemas/Scenario' }
 *               - type: object
 *                 properties:
 *                   scenarios:
 *                     type: array
 *                     items: { $ref: '#/components/schemas/Scenario' }
 *                 required: [scenarios]
 *           examples:
 *             bareArray:
 *               summary: Bare array
 *               value:
 *                 - id: sc-m2x1p0-a7f3c1
 *                   name: Commute
 *                   params:
 *                     - { type: gps.location, value: { lat: 55.751244, lon: 37.618423 } }
 *                     - { type: battery.level, value: 77 }
 *             wrapped:
 *               summary: Wrapped in an object
 *               value:
 *                 scenarios:
 *                   - id: sc-m2x1p0-a7f3c1
 *                     name: Commute
 *                     params:
 *                       - { type: network.wifi, value: false }
 *                       - { type: network.speed, value: '3g' }
 *             clearAll:
 *               summary: Empty array — deletes every scenario
 *               value: []
 *     responses:
 *       '200':
 *         description: Saved. The body is the sanitized set that was written.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ScenarioList' }
 *       '400':
 *         description: The body was neither an array nor an object carrying a `scenarios` array.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: expected an array of scenarios }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500': { $ref: '#/components/responses/ServerError' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /scenarios/{serial}/apply:
 *   post:
 *     tags: [scenarios]
 *     operationId: applyScenario
 *     summary: Apply a whole scenario to the device in one call
 *     description: |
 *       **Live device.** This is the heaviest operation in this group: it applies an entire saved
 *       scenario at once — GPS location, network (signal, speed, registration, Wi-Fi, airplane),
 *       battery level and charging, temperature, light, pose, sensor noise, Bluetooth, proxy,
 *       phone number, weather and Wi-Fi (BSSID) sync — to a running emulator. Try-it-out here will
 *       visibly change the state of an instance somebody may be using.
 *
 *       Send either `scenarioId` to apply a stored scenario, or `params` to apply an ad-hoc one.
 *       `params` wins when both are present. Neither is a 400.
 *
 *       Steps run sequentially with a short spacing between them, so a scenario with many params
 *       takes on the order of a second or two. Ordering is fixed, not the order you list params
 *       in: GPS is applied first (weather and BSSID sync read the location it sets), then sensor
 *       noise is reconciled so the scenario's explicit sensor values are held instead of being
 *       jittered away, then the rest. Network fields are collapsed into one apply, battery
 *       likewise.
 *
 *       **A 200 does not mean everything worked.** One failing param must not abort the rest of
 *       the scenario, so failures are collected instead of thrown: the response is HTTP 200 even
 *       when `ok` is false. `ok` is true only when `failures` is empty. Clients must inspect
 *       `applied` and `failures` rather than trusting the status code. Typical partial failures
 *       are an unknown pose preset, or `weather.on` / `bssid.on` in a scenario that carries no
 *       location and has no active GPS session.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ScenarioApplyRequest' }
 *           examples:
 *             byId:
 *               summary: Apply a stored scenario
 *               value: { scenarioId: sc-m2x1p0-a7f3c1 }
 *             adHoc:
 *               summary: Ad-hoc params, nothing stored
 *               value:
 *                 params:
 *                   - { type: gps.location, value: { lat: 55.751244, lon: 37.618423 } }
 *                   - { type: battery.level, value: 42 }
 *                   - { type: battery.charging, value: false }
 *                   - { type: network.signal, value: weak }
 *                   - { type: weather.on, value: true }
 *     responses:
 *       '200':
 *         description: |
 *           The scenario was run. Returned even when some params failed — check `ok` and
 *           `failures`, not the status code.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ScenarioApplyResult' }
 *             examples:
 *               allApplied:
 *                 summary: Everything applied
 *                 value:
 *                   ok: true
 *                   applied: [gps.location, network, battery]
 *                   failures: []
 *               partial:
 *                 summary: Partial failure — still HTTP 200
 *                 value:
 *                   ok: false
 *                   applied: [gps.location, battery]
 *                   failures:
 *                     - type: weather.on
 *                       error: weather needs a location — add "GPS location" to the scenario
 *       '400':
 *         description: Neither `scenarioId` nor `params` was given, or the body was not valid JSON.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: apply needs scenarioId or params }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '404':
 *         description: The `scenarioId` does not resolve to a stored scenario.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: scenario not found }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleScenarios(req, res, url) {
    const match = url.pathname.match(/^\/api\/scenarios\/([^/]+)(\/apply)?$/);
    if (!match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);
    const isApply = match[2] === '/apply';

    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    // ---- GET: list ----
    if (!isApply && req.method === 'GET') {
        try {
            const scenarios = scenariosStore.list();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, scenarios }));
        } catch (err) {
            log.error({ serial, err: err.message }, 'Failed to list scenarios');
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return true;
    }

    // ---- POST /apply: apply one scenario ----
    if (isApply && req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                // Prefer an explicit param list; else look the scenario up by id.
                let params = Array.isArray(body.params) ? body.params : null;
                if (!params && typeof body.scenarioId === 'string') {
                    const scenario = scenariosStore.get(body.scenarioId);
                    if (!scenario) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ ok: false, error: 'scenario not found' }));
                        return;
                    }
                    params = scenario.params;
                }
                if (!params) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false, error: 'apply needs scenarioId or params' }));
                    return;
                }
                const result = await applyScenario(serial, params);
                res.writeHead(200);
                res.end(JSON.stringify(result));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to apply scenario');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    // ---- POST: replace the whole set ----
    if (!isApply && req.method === 'POST') {
        readJsonBody(req)
            .then((body) => {
                // Accept a bare array or { scenarios: [...] }.
                const incoming = Array.isArray(body) ? body : (Array.isArray(body.scenarios) ? body.scenarios : null);
                if (!incoming) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false, error: 'expected an array of scenarios' }));
                    return;
                }
                const scenarios = scenariosStore.saveAll(incoming);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, scenarios }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to save scenarios');
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleScenarios };
