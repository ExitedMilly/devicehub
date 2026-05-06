'use strict';

const { instances, cameraInstances } = require('../stores');
const { registry } = require('../emulator-registry');
const { CameraInstance } = require('../camera/instance');
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

    // Resolve sinkIndex
    let sinkIndex = null;
    const captureInstance = instances.get(serial);
    if (captureInstance) {
        sinkIndex = captureInstance.sinkIndex;
    } else {
        const hostname = serial.split(':')[0];
        const info = registry.resolve(hostname);
        sinkIndex = info.sinkIndex;
    }

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

    camInst.start(ws);
    return true;
}

module.exports = handleCamera;
