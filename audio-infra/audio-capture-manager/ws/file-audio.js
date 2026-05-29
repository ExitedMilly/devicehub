'use strict';

const { micRtcInstances } = require('../stores');
const { WebRTCMicrophoneInstance } = require('../mic/webrtc');
const { resolveSinkIndex } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/file-audio');

function handleFileAudio(ws, url) {
    const match = url.pathname.match(/^\/file-audio\/(.+)$/);
    if (!match) return false;

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }

    let micInst = micRtcInstances.get(serial);
    if (!micInst || micInst.state === 'stopped') {
        micInst = new WebRTCMicrophoneInstance(serial, resolveSinkIndex(serial));
        micRtcInstances.set(serial, micInst);
    }

    if (micInst.client) {
        ws.close(4409, 'Mic busy (WebRTC session active)');
        return true;
    }
    if (micInst.fileInjectActive) {
        ws.close(4410, 'Mic busy (another file injection active)');
        return true;
    }

    micInst.startFileMode(ws);
    return true;
}

module.exports = handleFileAudio;
