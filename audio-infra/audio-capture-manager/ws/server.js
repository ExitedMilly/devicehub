'use strict';

const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { MANAGER_PORT } = require('../config');

const handlers = [
    require('./audio-output'),
    require('./mic-rtc'),
    require('./mic-state'),
    require('./camera'),
    require('./camera-state'),
];

function attachWsServer(httpServer) {
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://localhost:' + MANAGER_PORT);
        for (const handler of handlers) {
            if (handler(ws, url)) return;
        }
        ws.close(4000, 'Invalid path');
    });
    return wss;
}

module.exports = { attachWsServer };
