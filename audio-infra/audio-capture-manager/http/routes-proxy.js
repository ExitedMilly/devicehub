'use strict';

const { setProxy, clearProxy, getProxy, resolveHostAddress } = require('../domain/proxy');
const log = require('../log').getLogger('http/routes-proxy');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /proxy/{serial}:
 *   get:
 *     tags: [network]
 *     operationId: getProxy
 *     summary: Read the global HTTP proxy configured on the device
 *     description: |
 *       Reads `settings get global http_proxy` over adb and parses it. A raw value of `null`,
 *       `:0`, an empty string, or anything that does not split into a host and a positive port is
 *       reported as `enabled: false` with `host` and `port` null; `raw` always carries the
 *       unparsed setting so you can see what the device actually holds.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Current proxy state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ProxyState' }
 *             examples:
 *               enabled:
 *                 value: { ok: true, enabled: true, host: 172.20.0.1, port: 8888, raw: '172.20.0.1:8888' }
 *               disabled:
 *                 value: { ok: true, enabled: false, host: null, port: null, raw: ':0' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [network]
 *     operationId: setProxy
 *     summary: Point the device at an HTTP proxy
 *     description: |
 *       **Live device.** Writes `su 0 settings put global http_proxy <host>:<port>` over adb, so
 *       every app on the running emulator that honours the system proxy starts routing its traffic
 *       through the given address. Try-it-out on an instance somebody is using will redirect their
 *       traffic, and will break it outright if nothing is listening at that address. Takes effect
 *       immediately — no restart.
 *
 *       Root (`su 0`) is required to write a global setting; this works on the lab images.
 *
 *       **Use the docker-network gateway as the host**, not `10.0.2.2`. To reach a proxy such as
 *       mitmproxy running on the docker host, call `GET /proxy/{serial}/host-address` and use the
 *       address it returns. The proxy itself has to accept connections from the container — for
 *       mitmproxy that means `--listen-host 0.0.0.0` and `--set block_global=false`.
 *
 *       The response body is a fresh read of the setting taken after the write.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ProxyRequest' }
 *           examples:
 *             mitmOnHost:
 *               summary: mitmproxy on the docker host
 *               value: { host: 172.20.0.1, port: 8888 }
 *     responses:
 *       '200':
 *         description: Applied. The body is a fresh read of the setting.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ProxyState' }
 *             example: { ok: true, enabled: true, host: 172.20.0.1, port: 8888, raw: '172.20.0.1:8888' }
 *       '400':
 *         description: Missing or malformed `host`/`port`, or the adb write failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               badHost:
 *                 value: { ok: false, error: 'host must be a non-empty string without spaces' }
 *               badPort:
 *                 value: { ok: false, error: 'port must be an integer between 1 and 65535' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   delete:
 *     tags: [network]
 *     operationId: clearProxy
 *     summary: Remove the global HTTP proxy from the device
 *     description: |
 *       **Live device.** Writes `su 0 settings put global http_proxy :0` over adb, which is how
 *       Android spells "no proxy". Traffic on the running emulator goes direct again, immediately.
 *
 *       The response body is a fresh read of the setting, so `enabled` should come back false and
 *       `raw` as `:0`.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Cleared. The body is the post-clear state.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ProxyState' }
 *             example: { ok: true, enabled: false, host: null, port: null, raw: ':0' }
 *       '400': { $ref: '#/components/responses/BadRequest' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /proxy/{serial}/host-address:
 *   get:
 *     tags: [network]
 *     operationId: getProxyHostAddress
 *     summary: Resolve the address the device must use to reach the docker host
 *     description: |
 *       Helper for filling in the `host` of `POST /proxy/{serial}`. Returns the manager
 *       container's default gateway, read out of `/proc/net/route`, which is the docker-network
 *       gateway and therefore the docker host as seen from inside the network the emulator
 *       container NATs out through.
 *
 *       **`10.0.2.2` does not work here.** That slirp alias only resolves inside the emulator
 *       container's own network namespace, not on the docker network, so it is not an alternative
 *       to this address.
 *
 *       `hostAddress` is null when no default route could be parsed; that is a 200, not an error,
 *       so check the field rather than the status code.
 *
 *       Read-only, touches nothing on the device, and does not talk to adb at all — the serial in
 *       the path is only used for the access check.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Resolved gateway address, or null if the default route could not be read.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ProxyHostAddress' }
 *             examples:
 *               resolved:
 *                 value: { ok: true, hostAddress: 172.20.0.1 }
 *               unresolved:
 *                 summary: No default route found
 *                 value: { ok: true, hostAddress: null }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleProxy(req, res, url) {
    // GET /api/proxy/<serial>/host-address -> auto-detected host proxy address.
    const hostAddrMatch = url.pathname.match(/^\/api\/proxy\/([^/]+)\/host-address$/);
    // GET|POST|DELETE /api/proxy/<serial> (serial has no slash).
    const proxyMatch = url.pathname.match(/^\/api\/proxy\/([^/]+)$/);
    if (!hostAddrMatch && !proxyMatch) {
        return false;
    }

    const serial = decodeURIComponent((hostAddrMatch || proxyMatch)[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (hostAddrMatch && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, hostAddress: resolveHostAddress() }));
        return true;
    }

    if (proxyMatch && req.method === 'GET') {
        getProxy(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (proxyMatch && req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await setProxy(serial, body.host, body.port);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (proxyMatch && req.method === 'DELETE') {
        clearProxy(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to clear proxy');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleProxy };
