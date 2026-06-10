'use strict';

const { micRtcInstances } = require('../stores');
const { WebRTCMicrophoneInstance } = require('../mic/webrtc');
const { resolveSinkIndex } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/mic-rtc');

function handleMicRtc(ws, url) {
    const micRtcMatch = url.pathname.match(/^\/mic-rtc\/(.+)$/);
    if (!micRtcMatch) return false;

    const serial = decodeURIComponent(micRtcMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }

    const sinkIndex = resolveSinkIndex(serial);

    let micRtcInst = micRtcInstances.get(serial);
    if (!micRtcInst || micRtcInst.state === 'stopped') {
        micRtcInst = new WebRTCMicrophoneInstance(serial, sinkIndex);
        micRtcInstances.set(serial, micRtcInst);
    }

    if (micRtcInst.client) {
        ws.close(4009, 'Mic RTC already in use for ' + serial);
        return true;
    }

    if (micRtcInst.fileInjectActive) {
        ws.close(4409, 'Mic busy (file injection active)');
        return true;
    }

    micRtcInst.start(ws);
    return true;
}

module.exports = handleMicRtc;
