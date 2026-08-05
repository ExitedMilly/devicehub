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
const { handleBattery } = require('./routes-battery');
const { handleNetwork } = require('./routes-network');
const { handleProxy } = require('./routes-proxy');
const { handleFakeScan } = require('./routes-fake-scan');
const { handleBluetooth } = require('./routes-bluetooth');
const { handleBleBeacon } = require('./routes-ble-beacon');
const { handleSensorNoise } = require('./routes-sensor-noise');
const { handleTemperature } = require('./routes-temperature');
const { handleWeather } = require('./routes-weather');
const { handleWifiGeo } = require('./routes-wifi-geo');
const { handlePhonenumber } = require('./routes-phonenumber');
const { handleCellTower } = require('./routes-cell-tower');
const { handleCellSync } = require('./routes-cell-sync');
const { handleScenarios } = require('./routes-scenarios');
const { handleSchedule } = require('./routes-schedule');
const { handleBackup } = require('./routes-backup');
const { handleVideo } = require('./routes-video');
const { handleFileInject } = require('./routes-file-inject');
const { handleMetrics } = require('./routes-metrics');
const { handleDocs } = require('./routes-docs');
const { authMiddleware } = require('./auth-middleware');
const { incrCounter } = require('../metrics');

const handlers = [
    handleHealth,
    handleMetrics,
    // Docs are matched early; no domain handler owns /api/docs or /api/openapi.json.
    // Returns false when DOCS_ENABLED=0, so the request falls through to the 404 below.
    handleDocs,
    handleCapture,
    handleGps,
    handleWalk,
    handlePose,
    handleLight,
    handleBattery,
    handleNetwork,
    handleProxy,
    handleFakeScan,
    handleBluetooth,
    handleBleBeacon,
    handleSensorNoise,
    handleTemperature,
    handleWeather,
    handleWifiGeo,
    handlePhonenumber,
    handleCellTower,
    handleCellSync,
    handleScenarios,
    handleSchedule,
    handleBackup,
    handleVideo,
    handleFileInject,
];

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);
    incrCounter('capture_mgr_http_requests_total', { method: req.method });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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
