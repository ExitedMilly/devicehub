'use strict';

// Swagger UI + the generated OpenAPI document.
//
//   GET /api/docs           -> Swagger UI page (and its static assets under /api/docs/*)
//   GET /api/openapi.json   -> the raw spec, for validators and codegen
//
// Gating: when DOCS_ENABLED=0 this module registers nothing and returns false, so the
// request falls through to the generic 404 — a disabled docs endpoint is indistinguishable
// from a route that does not exist.
//
// Reference only: request execution is switched off (`supportedSubmitMethods: []`), so the page
// renders no Try-it-out or Execute control and never issues a request to a device. Anyone who
// wants to call the API takes /api/openapi.json and drives it from a real client.
//
// Auth: the page and the spec are NOT behind the Bearer check (see auth-middleware's
// EXEMPT_PATHS). A browser cannot attach an Authorization header to a top-level navigation, so
// requiring one would make the page unopenable. With execution disabled the page is a static
// rendering of the contract and cannot reach the API at all; the endpoints it describes stay
// gated exactly as before. Turn the page off in a shipped deployment with DOCS_ENABLED=0.

const { DOCS_ENABLED } = require('../config');
const log = require('../log').getLogger('http/routes-docs');

const DOCS_PREFIX = '/api/docs';
const SPEC_PATH = '/api/openapi.json';

let docsApp = null;   // express app hosting swagger-ui-express
let spec = null;      // generated OpenAPI document
let initError = null;

function build() {
    if (docsApp || initError) return;
    try {
        const express = require('express');
        const swaggerUi = require('swagger-ui-express');
        const swaggerJsdoc = require('swagger-jsdoc');
        const { options } = require('./openapi');

        spec = swaggerJsdoc(options);

        const app = express();
        app.disable('x-powered-by');
        app.use(
            DOCS_PREFIX,
            swaggerUi.serve,
            swaggerUi.setup(spec, {
                customSiteTitle: 'OrchID manager API',
                // The Authorize dialog only exists to hold a token for outgoing requests. With
                // execution disabled it can do nothing, so the button is hidden to avoid implying
                // the page can call the API. The `bearerAuth` scheme stays in the document itself,
                // where it belongs: it is what tells a client generator (or a Postman import) that
                // these endpoints need a Bearer token.
                //
                // Only `.auth-wrapper` is hidden, deliberately NOT `.scheme-container` — that block
                // also holds the servers dropdown, which is reference material worth keeping. The
                // per-operation padlocks stay too: they mark which endpoints require a token.
                customCss: '.swagger-ui .auth-wrapper { display: none }',
                swaggerOptions: {
                    // Empty list => Swagger UI renders no Try-it-out / Execute control for any
                    // HTTP method. This is the switch that makes the page reference-only.
                    supportedSubmitMethods: [],
                    docExpansion: 'none',
                    tagsSorter: 'alpha',
                },
            })
        );
        docsApp = app;

        const pathCount = Object.keys(spec.paths || {}).length;
        log.info({ paths: pathCount, openapi: spec.openapi }, 'OpenAPI spec built');
        if (!pathCount) {
            log.warn('OpenAPI spec has no paths — check the @openapi annotations in routes-*.js');
        }
    } catch (err) {
        initError = err;
        log.error({ err: err.message }, 'Failed to build OpenAPI docs');
    }
}

function handleDocs(req, res, url) {
    if (!DOCS_ENABLED) {
        return false; // -> generic 404
    }
    if (url.pathname !== SPEC_PATH && url.pathname !== DOCS_PREFIX && !url.pathname.startsWith(DOCS_PREFIX + '/')) {
        return false;
    }
    if (req.method !== 'GET') {
        return false;
    }

    build();

    if (initError) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: 'docs unavailable: ' + initError.message }));
        return true;
    }

    if (url.pathname === SPEC_PATH) {
        const body = JSON.stringify(spec, null, 2);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return true;
    }

    // Drop the JSON default the dispatcher sets for the whole API (http/server.js) before handing
    // off to express. Neither layer below overwrites an existing Content-Type: `send` bails out
    // early (`if (res.getHeader('Content-Type')) return`), and express's `res.send` only falls back
    // to text/html when nothing is set. So the pre-set header would stick to the Swagger UI page
    // and to every static asset, and the browser would try to parse HTML and CSS as JSON.
    // swagger-ui-init.js was the one file that came out right, because swagger-ui-express sets its
    // type explicitly with `res.set`.
    //
    // Clearing it here — rather than changing the dispatcher — keeps `application/json` as the
    // default for the rest of the API. Everything under the docs prefix gets its type from
    // express: text/html for the page, application/javascript and text/css for the assets.
    // The JSON spec route above is unaffected: it writes its own Content-Type explicitly.
    res.removeHeader('Content-Type');

    // An express app is just an (req, res) handler, so the raw http server can delegate.
    docsApp(req, res);
    return true;
}

module.exports = { handleDocs, DOCS_PREFIX, SPEC_PATH };
