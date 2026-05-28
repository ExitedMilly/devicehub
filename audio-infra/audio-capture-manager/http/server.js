'use strict';

const http = require('http');
const { URL } = require('url');
const { MANAGER_PORT } = require('../config');

const { handleHealth } = require('./routes-health');
const { handleCapture } = require('./routes-capture');
const { handleGps } = require('./routes-gps');
const { handleWalk } = require('./routes-walk');
const { handlePose } = require('./routes-pose');
const { handleLight } = require('./routes-light');
const { handleBackup } = require('./routes-backup');
const { handleVideo } = require('./routes-video');
const { handleMetrics } = require('./routes-metrics');
const { authMiddleware } = require('./auth-middleware');
const { incrCounter } = require('../metrics');

const handlers = [
    handleHealth,
    handleMetrics,
    handleCapture,
    handleGps,
    handleWalk,
    handlePose,
    handleLight,
    handleBackup,
    handleVideo,
];

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);
    incrCounter('capture_mgr_http_requests_total', { method: req.method });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (await authMiddleware(req, res, url)) return;

    for (const handler of handlers) {
        if (handler(req, res, url)) return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
});

module.exports = { server };
