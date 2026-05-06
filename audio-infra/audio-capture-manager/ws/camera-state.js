'use strict';

const { cameraStateMonitor } = require('../camera/state-monitor');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/camera-state');

function handleCameraState(ws, url) {
    const cameraStateMatch = url.pathname.match(/^\/camera-state\/(.+)$/);
    if (!cameraStateMatch) return false;

    const serial = decodeURIComponent(cameraStateMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }
    log.info({ serial }, 'Subscriber connected');
    cameraStateMonitor.subscribe(serial, ws);

    ws.on('close', () => {
        log.info({ serial }, 'Subscriber disconnected');
    });
    return true;
}

module.exports = handleCameraState;
