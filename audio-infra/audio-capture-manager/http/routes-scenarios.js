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
