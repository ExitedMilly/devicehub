'use strict';

const { micStateMonitor } = require('../mic/state-monitor');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/mic-state');

function handleMicState(ws, url) {
    const micStateMatch = url.pathname.match(/^\/mic-state\/(.+)$/);
    if (!micStateMatch) return false;

    const serial = decodeURIComponent(micStateMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }
    log.info({ serial }, 'Subscriber connected');
    micStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        log.info({ serial }, 'Subscriber disconnected');
    });
    return true;
}

module.exports = handleMicState;
