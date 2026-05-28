'use strict';

const { render } = require('../metrics');

function handleMetrics(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
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
