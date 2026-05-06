'use strict';

const { execSync } = require('child_process');
const { PA_SERVER, PA_POLL_INTERVAL_MS, AUTO_DISCOVER } = require('./config');
const { instances } = require('./stores');
const { registry } = require('./emulator-registry');
const { CaptureInstance } = require('./audio/capture');
const { PULSE_SINK_PREFIX } = require('./config');

// ===================== PA Monitor =====================
// Polls PulseAudio for QEMU sink-inputs, auto-routes and auto-starts capture

class PAMonitor {
    constructor() {
        this.knownSinkInputs = new Map(); // sink-input-id → { hostname, sinkIndex, serial }
        this.timer = null;
        this.dtsErrorCounts = new Map(); // serial → count
    }

    start() {
        if (!AUTO_DISCOVER) {
            console.log('[pa-monitor] Auto-discovery disabled');
            return;
        }
        console.log('[pa-monitor] Starting auto-discovery (poll every ' + PA_POLL_INTERVAL_MS + 'ms)');
        this.timer = setInterval(() => this.poll(), PA_POLL_INTERVAL_MS);
        // First poll immediately
        setTimeout(() => this.poll(), 1000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    poll() {
        try {
            const output = execSync(
                'pactl --server="' + PA_SERVER + '" list sink-inputs 2>/dev/null',
                { encoding: 'utf8', timeout: 5000 }
            );
            this.processSinkInputs(output);
        } catch (err) {
            // PA not available — that's ok, will retry
        }
    }

    processSinkInputs(output) {
        const currentInputs = this.parseSinkInputs(output);
        const currentIds = new Set(currentInputs.map(i => i.id));

        // Detect new QEMU sink-inputs
        for (const input of currentInputs) {
            if (input.appBinary !== 'qemu-system-x86_64') continue;

            if (!this.knownSinkInputs.has(input.id)) {
                this.onNewQemu(input);
            } else {
                // Capture may have been stopped — restart if needed
                const info = this.knownSinkInputs.get(input.id);
                const inst = instances.get(info.serial);
                if (!inst || inst.state !== "running") {
                    console.log("[pa-monitor] Capture not running for known input #" + input.id + ", restarting");
                    this.knownSinkInputs.delete(input.id);
                    this.onNewQemu(input);
                }
            }
        }

        // Detect removed sink-inputs
        for (const [id, info] of this.knownSinkInputs) {
            if (!currentIds.has(id)) {
                this.onRemovedQemu(id, info);
            }
        }
    }

    onNewQemu(input) {
        const hostname = input.hostname || 'unknown';
        const info = registry.resolve(hostname);
        const targetSink = PULSE_SINK_PREFIX + info.sinkIndex;

        console.log('[pa-monitor] New QEMU detected: sink-input #' + input.id +
            ' from ' + hostname + ' → routing to ' + targetSink +
            ', serial=' + info.serial);

        this.knownSinkInputs.set(input.id, {
            hostname: hostname,
            sinkIndex: info.sinkIndex,
            serial: info.serial
        });

        // 1. Route sink-input to correct null-sink
        if (input.sinkName !== targetSink) {
            try {
                execSync(
                    'pactl --server="' + PA_SERVER + '" move-sink-input ' + input.id + ' ' + targetSink,
                    { timeout: 3000 }
                );
                console.log('[pa-monitor] Routed sink-input #' + input.id + ' to ' + targetSink);
            } catch (err) {
                console.error('[pa-monitor] Failed to route sink-input #' + input.id + ': ' + err.message);
            }
        } else {
            console.log('[pa-monitor] Sink-input #' + input.id + ' already on ' + targetSink);
        }

        // 2. Auto-start capture if not already running
        if (!instances.has(info.serial) || instances.get(info.serial).state !== 'running') {
            console.log('[pa-monitor] Auto-starting capture for ' + info.serial);
            const instance = new CaptureInstance(info.serial, info.sinkIndex);
            instances.set(info.serial, instance);
            instance.start();
        }
    }

    onRemovedQemu(id, info) {
        console.log('[pa-monitor] QEMU disconnected: sink-input #' + id +
            ' (serial=' + info.serial + ')');
        this.knownSinkInputs.delete(id);

        // Check if any other sink-inputs exist for this serial
        let hasOther = false;
        for (const [, other] of this.knownSinkInputs) {
            if (other.serial === info.serial) {
                hasOther = true;
                break;
            }
        }

        if (!hasOther) {
            // No more QEMU inputs for this emulator — stop capture
            const instance = instances.get(info.serial);
            if (instance) {
                console.log('[pa-monitor] Auto-stopping capture for ' + info.serial);
                instance.stop();
                instances.delete(info.serial);
            }
        }
    }

    // Track DTS errors for auto-restart
    trackDtsError(serial) {
        const count = (this.dtsErrorCounts.get(serial) || 0) + 1;
        this.dtsErrorCounts.set(serial, count);

        // After 50 DTS errors, restart FFmpeg
        if (count >= 50) {
            this.dtsErrorCounts.set(serial, 0);
            const instance = instances.get(serial);
            if (instance && instance.state === 'running') {
                console.log('[pa-monitor] Too many DTS errors for ' + serial + ', restarting capture');
                instance.stop();
                setTimeout(() => {
                    if (instances.has(serial)) {
                        instances.get(serial).start();
                    } else {
                        const info = this.knownSinkInputs.values().next().value;
                        if (info && info.serial === serial) {
                            const inst = new CaptureInstance(serial, info.sinkIndex);
                            instances.set(serial, inst);
                            inst.start();
                        }
                    }
                }, 1000);
            }
        }
    }

    parseSinkInputs(output) {
        const inputs = [];
        let current = null;

        for (const line of output.split('\n')) {
            const idMatch = line.match(/^Sink Input #(\d+)/);
            if (idMatch) {
                if (current) inputs.push(current);
                current = { id: parseInt(idMatch[1]), sinkName: null, appBinary: null, hostname: null };
                continue;
            }
            if (!current) continue;

            const sinkMatch = line.match(/^\tSink:\s+(\d+)/);
            if (sinkMatch) {
                // We need sink name, not index — will resolve below
                current.sinkIndex = parseInt(sinkMatch[1]);
            }

            const propMatch = line.match(/^\t\t(.+?)\s*=\s*"(.+?)"/);
            if (propMatch) {
                const key = propMatch[1];
                const val = propMatch[2];
                if (key === 'application.process.binary') current.appBinary = val;
                if (key === 'application.process.host') current.hostname = val;
            }
        }
        if (current) inputs.push(current);

        return inputs;
    }
}

const paMonitor = new PAMonitor();

module.exports = { paMonitor, PAMonitor };
