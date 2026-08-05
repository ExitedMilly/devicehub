/**
 * Compiles the manager's OpenAPI document into the frontend's static assets.
 *
 * The contract lives where the code is: the base document in
 * audio-infra/audio-capture-manager/http/openapi.js and one @openapi JSDoc block above each
 * handler in that directory's routes-*.js. Nothing is duplicated here — this script only
 * runs swagger-jsdoc over those sources and drops the result next to the page that renders
 * it, together with the Swagger UI assets so the page needs no network at runtime.
 *
 * It is wired into the frontend build (ui `build:prod` and the builder stage of the root
 * Dockerfile), so the shipped document cannot drift from the annotations: a stale spec would
 * need someone to build the image without building the UI, which does not happen. Generating
 * at build time also keeps the artefact out of git — there is no committed copy to forget to
 * refresh.
 *
 * Fails the build on an empty or unparseable spec rather than shipping a broken page.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '..');
const repoRoot = resolve(uiRoot, '..');
const specSource = join(repoRoot, 'audio-infra', 'audio-capture-manager', 'http', 'openapi.js');
const outDir = join(uiRoot, 'public', 'api-docs');

const require = createRequire(import.meta.url);

// The Swagger UI runtime, copied out of node_modules so the page is self-contained.
const ASSETS = [
    'swagger-ui.css',
    'swagger-ui-bundle.js',
    'swagger-ui-standalone-preset.js',
];

function fail(message) {
    console.error(`[openapi] ${message}`);
    process.exit(1);
}

let swaggerJsdoc;
let options;
try {
    swaggerJsdoc = require('swagger-jsdoc');
} catch (err) {
    fail(`swagger-jsdoc is not installed in ui/: ${err.message}`);
}
try {
    ({ options } = require(specSource));
} catch (err) {
    fail(`cannot load the spec source at ${specSource}: ${err.message}`);
}

let spec;
try {
    spec = swaggerJsdoc(options);
} catch (err) {
    fail(`swagger-jsdoc could not build the document: ${err.message}`);
}

const paths = Object.keys(spec.paths || {});
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const operations = paths.reduce(
    (total, p) => total + METHODS.filter((m) => spec.paths[p][m]).length,
    0
);

if (!paths.length || !operations) {
    fail('the generated document has no paths — check the @openapi blocks in routes-*.js');
}

// Local $refs must resolve, otherwise the page renders half-empty at runtime instead of
// failing here where somebody is watching.
const broken = [];
(function walk(node, where) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
            let cur = spec;
            for (const seg of value.slice(2).split('/')) {
                cur = cur && cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
            }
            if (cur === undefined) broken.push(`${where}: ${value}`);
        } else {
            walk(value, `${where}/${key}`);
        }
    }
})(spec, '');
if (broken.length) {
    fail(`unresolved $ref(s):\n  ${broken.slice(0, 10).join('\n  ')}`);
}

await rm(join(outDir, 'openapi.json'), { force: true });
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);

let assetDir;
try {
    assetDir = dirname(require.resolve('swagger-ui-dist/swagger-ui.css'));
} catch (err) {
    fail(`swagger-ui-dist is not installed in ui/: ${err.message}`);
}
for (const asset of ASSETS) {
    await copyFile(join(assetDir, asset), join(outDir, asset));
}

console.log(
    `[openapi] ${spec.openapi} · ${paths.length} paths · ${operations} operations -> ` +
    `public/api-docs/openapi.json (+${ASSETS.length} Swagger UI assets)`
);
