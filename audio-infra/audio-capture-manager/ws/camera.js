'use strict';

const { cameraInstances } = require('../stores');
const { CameraInstance } = require('../camera/instance');
const { resolveSinkIndex } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/camera');

function handleCamera(ws, url) {
    const cameraMatch = url.pathname.match(/^\/camera\/(.+)$/);
    if (!cameraMatch) return false;

    const serial = decodeURIComponent(cameraMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }

    const sinkIndex = resolveSinkIndex(serial);

    // Get or create CameraInstance
    let camInst = cameraInstances.get(serial);
    if (!camInst || camInst.state === 'stopped') {
        camInst = new CameraInstance(serial, sinkIndex);
        cameraInstances.set(serial, camInst);
    }

    if (camInst.client) {
        ws.close(4009, 'Camera already in use for ' + serial);
        return true;
    }

    if (camInst.fileInjectActive) {
        ws.close(4409, 'Camera busy (file injection active)');
        return true;
    }

    camInst.start(ws);
    return true;
}

module.exports = handleCamera;
