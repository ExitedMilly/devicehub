'use strict';

const { instances, micRtcInstances } = require('../stores');
const { registry } = require('../emulator-registry');
const { WebRTCMicrophoneInstance } = require('../mic/webrtc');
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

    let sinkIndex = null;
    const captureInstance = instances.get(serial);
    if (captureInstance) {
        sinkIndex = captureInstance.sinkIndex;
    } else {
        const hostname = serial.split(':')[0];
        const info = registry.resolve(hostname);
        sinkIndex = info.sinkIndex;
    }

    let micRtcInst = micRtcInstances.get(serial);
    if (!micRtcInst || micRtcInst.state === 'stopped') {
        micRtcInst = new WebRTCMicrophoneInstance(serial, sinkIndex);
        micRtcInstances.set(serial, micRtcInst);
    }

    if (micRtcInst.client) {
        ws.close(4009, 'Mic RTC already in use for ' + serial);
        return true;
    }

    micRtcInst.start(ws);
    return true;
}

module.exports = handleMicRtc;
