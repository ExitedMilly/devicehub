'use strict';

const { cameraStateMonitor } = require('../camera/state-monitor');

function handleCameraState(ws, url) {
    const cameraStateMatch = url.pathname.match(/^\/camera-state\/(.+)$/);
    if (!cameraStateMatch) return false;

    const serial = decodeURIComponent(cameraStateMatch[1]);
    console.log('[camera-state] Subscriber connected for ' + serial);
    cameraStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        console.log('[camera-state] Subscriber disconnected for ' + serial);
    });
    return true;
}

module.exports = handleCameraState;
