'use strict';

const { render } = require('../metrics');
const { collectGauges } = require('../metrics-app');

/**
 * @openapi
 * /metrics:
 *   get:
 *     tags: [system]
 *     operationId: getMetrics
 *     summary: Prometheus metrics exposition
 *     description: |
 *       Read-only. Returns the Prometheus text exposition format, **not JSON** — this is the one
 *       endpoint in this API whose response is `text/plain`. Meant for a scraper.
 *
 *       Like `/health`, it is exempt from authentication and answers 200 without a token even when
 *       `AUTH_REQUIRED=1`. Counters include `capture_mgr_http_requests_total`,
 *       `capture_mgr_ws_connections_total`, `capture_mgr_ownership_checks_total` and
 *       `capture_mgr_ownership_cache_hits_total`.
 *     security: []
 *     responses:
 *       '200':
 *         description: Metrics in Prometheus exposition format.
 *         content:
 *           text/plain:
 *             schema: { type: string }
 *             example: |
 *               # HELP capture_mgr_http_requests_total HTTP requests
 *               # TYPE capture_mgr_http_requests_total counter
 *               capture_mgr_http_requests_total{method="GET"} 128
 */
function handleMetrics(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
        collectGauges();
        const body = render();
        res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return true;
    }
    return false;
}

module.exports = { handleMetrics };
