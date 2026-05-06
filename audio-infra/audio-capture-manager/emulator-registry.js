'use strict';

const { EMULATOR_MAP_RAW, ADB_PORT, SINGLE_MODE, INSTANCE_SERIAL } = require('./config');
const log = require('./log').getLogger('emulator-registry');

// ===================== Emulator Registry =====================
// Maps container hostnames to sink indexes and serials

class EmulatorRegistry {
    constructor() {
        // hostname → { sinkIndex, serial }
        this.map = new Map();
        this.nextAutoIndex = 1;

        if (SINGLE_MODE) {
            // Static single-instance mapping. sinkIndex = 1 is a placeholder
            // (real sink name comes from PULSE_SINK_NAME via audio/capture.js).
            const hostname = INSTANCE_SERIAL.split(':')[0];
            this.map.set(hostname, { sinkIndex: 1, serial: INSTANCE_SERIAL });
            log.info({ hostname, serial: INSTANCE_SERIAL, sinkIndex: 1 }, 'Single-mode static mapping');
        } else {
            this._parseEnvMap();
        }
    }

    _parseEnvMap() {
        if (!EMULATOR_MAP_RAW) return;
        // Format: hostname_prefix:sink_index:serial,...
        for (const entry of EMULATOR_MAP_RAW.split(',')) {
            const parts = entry.trim().split(':');
            if (parts.length >= 3) {
                const hostname = parts[0];
                const sinkIndex = parseInt(parts[1]);
                const serial = parts.slice(2).join(':'); // serial may contain ':'
                this.map.set(hostname, { sinkIndex, serial });
                log.info({ hostname, sinkIndex, serial }, 'Static mapping registered');
                if (sinkIndex >= this.nextAutoIndex) {
                    this.nextAutoIndex = sinkIndex + 1;
                }
            }
        }
    }

    resolve(hostname) {
        if (SINGLE_MODE) {
            // Always return the static single-instance mapping regardless of
            // input hostname — only one emulator is allowed.
            return this.map.values().next().value;
        }

        // Exact match
        if (this.map.has(hostname)) {
            return this.map.get(hostname);
        }
        // Prefix match (hostname might be full container ID, map has short name)
        for (const [prefix, info] of this.map) {
            if (hostname.startsWith(prefix)) {
                return info;
            }
        }
        // Auto-assign
        const sinkIndex = this.nextAutoIndex++;
        const serial = hostname + ':' + ADB_PORT; // best guess
        const info = { sinkIndex, serial };
        this.map.set(hostname, info);
        log.info({ hostname, sinkIndex, serial }, 'Auto-assigned hostname to sink');
        return info;
    }
}

const registry = new EmulatorRegistry();

module.exports = { registry, EmulatorRegistry };
