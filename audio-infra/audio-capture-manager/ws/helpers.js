'use strict';

const { instances } = require('../stores');
const { registry } = require('../emulator-registry');

/**
 * Resolve sinkIndex for a serial, preferring an active CaptureInstance
 * if one exists, otherwise falling back to static registry lookup.
 *
 * Used by mic-rtc and camera WS handlers to bootstrap their per-serial
 * instance with the correct PulseAudio sink index.
 */
function resolveSinkIndex(serial) {
    const captureInstance = instances.get(serial);
    if (captureInstance) {
        return captureInstance.sinkIndex;
    }
    const hostname = serial.split(':')[0];
    const info = registry.resolve(hostname);
    return info.sinkIndex;
}

module.exports = { resolveSinkIndex };
