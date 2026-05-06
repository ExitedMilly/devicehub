'use strict';

const { instances } = require('../stores');
const { CaptureInstance } = require('../audio/capture');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('http/routes-capture');

function handleCapture(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/capture/start') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial, sinkIndex } = JSON.parse(body);
                if (!serial || !sinkIndex) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial and sinkIndex required' })); return; }
                if (!isSerialAllowed(serial)) {
                    log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
                    return;
                }
                if (instances.has(serial)) {
                    const existing = instances.get(serial);
                    if (existing.state === 'running') {
                        res.writeHead(200);
                        res.end(JSON.stringify({ status: 'already_running', ...existing.toJSON() }));
                        return;
                    }
                    existing.stop();
                }
                const instance = new CaptureInstance(serial, sinkIndex);
                instances.set(serial, instance);
                instance.start();
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'started', ...instance.toJSON() }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/stop') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
            try {
                const { serial } = JSON.parse(body);
                if (!serial) { res.writeHead(400); res.end(JSON.stringify({ error: 'serial required' })); return; }
                if (!isSerialAllowed(serial)) {
                    log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
                    return;
                }
                const instance = instances.get(serial);
                if (!instance) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
                instance.stop();
                instances.delete(serial);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'stopped', serial }));
            } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
        });
        return true;
    }

    return false;
}

module.exports = { handleCapture };
