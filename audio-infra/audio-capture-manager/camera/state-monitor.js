'use strict';

const { execSync } = require('child_process');
const { WebSocket } = require('ws');
const { CAMERA_STATE_POLL_MS } = require('../config');
const { registry } = require('../emulator-registry');

// ===================== Camera State Monitor =====================
// Polls adb "dumpsys media.camera" for Active Camera Clients.
// When Android app opens camera → 'active', closes → 'inactive'.

class CameraStateMonitor {
    constructor() {
        // serial → 'active' | 'inactive' | 'unknown'
        this.states = new Map();
        // serial → Set<WebSocket>
        this.subscribers = new Map();
        this.timer = null;
    }

    start() {
        console.log('[camera-state] Starting camera state monitor via adb (poll every ' + CAMERA_STATE_POLL_MS + 'ms)');
        this.timer = setInterval(() => this.pollAll(), CAMERA_STATE_POLL_MS);
        setTimeout(() => this.pollAll(), 5000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    pollAll() {
        for (const [hostname, info] of registry.map) {
            this.pollEmulator(hostname, info.serial);
        }
    }

    pollEmulator(hostname, serial) {
        const adbTarget = hostname + ':5555';
        try {
            const output = execSync(
                'adb -s ' + adbTarget + ' shell "dumpsys media.camera" 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processCameraDump(hostname, serial, output);
        } catch (err) {
            // adb failed — skip this poll
        }
    }

    processCameraDump(hostname, serial, output) {
        // Parse "Active Camera Clients:" section
        // When camera is active:
        //   Active Camera Clients:
        //   [
        //   (Camera ID: 0, Cost: 100, PID: 10846, ...)
        //   ]
        // When camera is inactive:
        //   Active Camera Clients:
        //   [
        //   ]
        let inActiveClients = false;
        let inBrackets = false;
        let hasActiveClient = false;

        for (const line of output.split('\n')) {
            const trimmed = line.trim();

            if (trimmed.startsWith('Active Camera Clients:')) {
                inActiveClients = true;
                continue;
            }

            if (inActiveClients) {
                if (trimmed === '[') {
                    inBrackets = true;
                    continue;
                }
                if (trimmed === ']') {
                    break;
                }
                if (inBrackets && trimmed.startsWith('(Camera ID:')) {
                    hasActiveClient = true;
                    break;
                }
                // Any other line after Active Camera Clients that's not [ or ] — end of section
                if (!inBrackets && trimmed.length > 0) {
                    break;
                }
            }
        }

        const newState = hasActiveClient ? 'active' : 'inactive';
        const oldState = this.states.get(serial);
        if (oldState !== newState) {
            this.states.set(serial, newState);
            console.log('[camera-state] ' + serial + ': ' + (oldState || 'unknown') + ' → ' + newState);
            this._notifySubscribers(serial, newState);
        }
    }

    subscribe(serial, ws) {
        const hostname = serial.split(':')[0];
        if (!this.subscribers.has(hostname)) {
            this.subscribers.set(hostname, new Set());
        }
        this.subscribers.get(hostname).add(ws);

        // Send current state immediately
        const currentState = this.states.get(serial) || 'unknown';
        this._sendState(ws, serial, currentState);

        ws.on('close', () => {
            const subs = this.subscribers.get(hostname);
            if (subs) {
                subs.delete(ws);
                if (subs.size === 0) this.subscribers.delete(hostname);
            }
        });
    }

    _notifySubscribers(serial, state) {
        const hostname = serial.split(':')[0];
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
                type: 'camera_state',
                serial: serial,
                state: state // 'active' | 'inactive' | 'unknown'
            }));
        } catch (err) {
            // ignore
        }
    }
}

const cameraStateMonitor = new CameraStateMonitor();

module.exports = { cameraStateMonitor, CameraStateMonitor };
