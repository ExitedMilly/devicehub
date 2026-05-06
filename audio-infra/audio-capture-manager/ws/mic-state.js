'use strict';

const { micStateMonitor } = require('../mic/state-monitor');

function handleMicState(ws, url) {
    const micStateMatch = url.pathname.match(/^\/mic-state\/(.+)$/);
    if (!micStateMatch) return false;

    const serial = decodeURIComponent(micStateMatch[1]);
    console.log('[mic-state] Subscriber connected for ' + serial);
    micStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        console.log('[mic-state] Subscriber disconnected for ' + serial);
    });
    return true;
}

module.exports = handleMicState;
