'use strict';

const { cameraStateMonitor } = require('../camera/state-monitor');
const log = require('../log').getLogger('ws/camera-state');

function handleCameraState(ws, url) {
    const cameraStateMatch = url.pathname.match(/^\/camera-state\/(.+)$/);
    if (!cameraStateMatch) return false;

    const serial = decodeURIComponent(cameraStateMatch[1]);
    log.info({ serial }, 'Subscriber connected');
    cameraStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        log.info({ serial }, 'Subscriber disconnected');
    });
    return true;
}

module.exports = handleCameraState;
