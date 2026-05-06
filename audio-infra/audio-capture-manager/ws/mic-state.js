'use strict';

const { micStateMonitor } = require('../mic/state-monitor');
const log = require('../log').getLogger('ws/mic-state');

function handleMicState(ws, url) {
    const micStateMatch = url.pathname.match(/^\/mic-state\/(.+)$/);
    if (!micStateMatch) return false;

    const serial = decodeURIComponent(micStateMatch[1]);
    log.info({ serial }, 'Subscriber connected');
    micStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        log.info({ serial }, 'Subscriber disconnected');
    });
    return true;
}

module.exports = handleMicState;
