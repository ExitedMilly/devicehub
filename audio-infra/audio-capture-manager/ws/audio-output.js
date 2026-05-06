'use strict';

const { instances } = require('../stores');

function handleAudioOutput(ws, url) {
    const audioMatch = url.pathname.match(/^\/audio\/(.+)$/);
    if (!audioMatch) return false;

    const serial = decodeURIComponent(audioMatch[1]);
    const instance = instances.get(serial);
    if (!instance) { ws.close(4004, 'No capture for ' + serial); return true; }
    if (instance.state !== 'running') { ws.close(4003, 'Not ready: ' + instance.state); return true; }
    instance.addClient(ws);
    return true;
}

module.exports = handleAudioOutput;
