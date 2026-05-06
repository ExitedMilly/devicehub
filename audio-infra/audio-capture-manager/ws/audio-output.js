'use strict';

const { instances } = require('../stores');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');
const log = require('../log').getLogger('ws/audio-output');

function handleAudioOutput(ws, url) {
    const audioMatch = url.pathname.match(/^\/audio\/(.+)$/);
    if (!audioMatch) return false;

    const serial = decodeURIComponent(audioMatch[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL }, 'Serial not allowed in single mode');
        ws.close(4002, 'Serial not allowed in single mode');
        return true;
    }
    const instance = instances.get(serial);
    if (!instance) { ws.close(4004, 'No capture for ' + serial); return true; }
    if (instance.state !== 'running') { ws.close(4003, 'Not ready: ' + instance.state); return true; }
    instance.addClient(ws);
    return true;
}

module.exports = handleAudioOutput;
