'use strict';

const { execSync } = require('child_process');
const { WebSocket } = require('ws');
const { MIC_STATE_POLL_MS } = require('../config');
const { registry } = require('../emulator-registry');

// ===================== Mic State Monitor =====================
// Polls PulseAudio source-outputs for QEMU Corked state.
// When Android app requests microphone — QEMU uncorks its source-output (Corked: no → listening).
// When Android app stops — QEMU corks it back (Corked: yes → idle).

class MicStateMonitor {
    constructor() {
        // serial → 'listening' | 'idle' (the last confirmed/sent state)
        this.states = new Map();
        // serial → Set<WebSocket> (subscribers)
        this.subscribers = new Map();
        // serial → adb connected flag
        this.adbConnected = new Map();
        this.timer = null;
    }

    start() {
        console.log('[mic-state] Starting mic state monitor via adb (poll every ' + MIC_STATE_POLL_MS + 'ms)');
        this.timer = setInterval(() => this.pollAll(), MIC_STATE_POLL_MS);
        // First poll after a short delay (let emulators boot)
        setTimeout(() => this.pollAll(), 5000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // Poll all known emulators (from registry)
    pollAll() {
        for (const [hostname, info] of registry.map) {
            this.pollEmulator(hostname, info.serial);
        }
    }

    pollEmulator(hostname, serial) {
        const adbTarget = hostname + ':5555';

        // Ensure adb is connected to this emulator
        if (!this.adbConnected.get(serial)) {
            try {
                execSync('adb connect ' + adbTarget + ' 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
                this.adbConnected.set(serial, true);
                console.log('[mic-state] adb connected to ' + adbTarget);
            } catch (err) {
                // Not ready yet — will retry next poll
                return;
            }
        }

        try {
            // Get last rec start/stop event from Android audio service
            const output = execSync(
                'adb -s ' + adbTarget + ' shell "dumpsys audio" 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processAudioDump(hostname, serial, output);
        } catch (err) {
            // adb failed — mark as disconnected for reconnect on next poll
            this.adbConnected.set(serial, false);
        }
    }

    processAudioDump(hostname, serial, output) {
        // Check RecordActivityMonitor section for active recording sessions.
        // Format varies between adb access methods:
        //
        // Via docker exec emulator:
        //   RecordActivityMonitor dump time: 8:09:20 AM
        //     session:129 -- source client=CAMCORDER ...
        //
        // Via adb from another container:
        //   RecordActivityMonitor dump time: 8:24:57 AM
        //   riid 183; active? true
        //     session:193 -- source client=CAMCORDER ...
        //
        // Idle (both):
        //   RecordActivityMonitor dump time: 8:10:03 AM
        //   Audio event log: ...
        let inRecordMonitor = false;
        let hasActiveSession = false;

        for (const line of output.split('\n')) {
            if (line.includes('RecordActivityMonitor dump time:')) {
                inRecordMonitor = true;
                continue;
            }

            if (inRecordMonitor) {
                const trimmed = line.trim();
                // Active session indicator
                if (trimmed.startsWith('session:') || trimmed.includes('active? true')) {
                    hasActiveSession = true;
                    break;
                }
                // Skip empty lines within the section
                if (trimmed.length === 0) {
                    continue;
                }
                // Lines starting with 'riid' are part of the section — keep scanning
                if (trimmed.startsWith('riid ')) {
                    continue;
                }
                // Any other non-empty line means we've left the section
                break;
            }
        }

        const newState = hasActiveSession ? 'listening' : 'idle';

        const oldState = this.states.get(serial);
        if (oldState !== newState) {
            this.states.set(serial, newState);
            console.log('[mic-state] ' + serial + ': ' + (oldState || 'unknown') + ' → ' + newState);
            this._notifySubscribers(hostname, serial, newState);
        }
    }

    // Get current state for a hostname
    getState(hostname) {
        // Look up by hostname → serial
        const info = registry.map.get(hostname);
        if (info) {
            return this.states.get(info.serial) || 'unknown';
        }
        return 'unknown';
    }

    // Get state by serial (serial format: "hostname:port")
    getStateBySerial(serial) {
        return this.states.get(serial) || 'unknown';
    }

    // Subscribe a WebSocket to state changes for a given serial
    subscribe(serial, ws) {
        const hostname = serial.split(':')[0];
        if (!this.subscribers.has(hostname)) {
            this.subscribers.set(hostname, new Set());
        }
        this.subscribers.get(hostname).add(ws);

        // Send current state immediately
        const currentState = this.getStateBySerial(serial);
        this._sendState(ws, serial, currentState);

        // Trigger immediate poll for this emulator
        const info = registry.map.get(hostname);
        if (info) {
            this.pollEmulator(hostname, info.serial);
        }

        ws.on('close', () => {
            const subs = this.subscribers.get(hostname);
            if (subs) {
                subs.delete(ws);
                if (subs.size === 0) this.subscribers.delete(hostname);
            }
        });
    }

    _notifySubscribers(hostname, serial, state) {
        const subs = this.subscribers.get(hostname);
        if (!subs) return;

        for (const ws of subs) {
            this._sendState(ws, serial, state);
        }
    }

    _sendState(ws, serial, state) {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({
                type: 'mic_state',
                serial: serial,
                state: state // 'listening' | 'idle' | 'unknown'
            }));
        } catch (err) {
            // ignore send errors
        }
    }
}

const micStateMonitor = new MicStateMonitor();

module.exports = { micStateMonitor, MicStateMonitor };
