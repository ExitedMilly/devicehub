'use strict';

// Simple Prometheus-format metrics store. No external deps.
// Counters monotonically increase; gauges can move both ways.

const counters = new Map();   // 'name{labels}' → number
const gauges = new Map();     // 'name{labels}' → number
const metricMeta = new Map(); // 'name' → { help, type }

function _makeKey(name, labels) {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return name;
    const labelStr = keys.map((k) => `${k}="${labels[k]}"`).join(',');
    return `${name}{${labelStr}}`;
}

function registerCounter(name, help) {
    metricMeta.set(name, { help, type: 'counter' });
}

function registerGauge(name, help) {
    metricMeta.set(name, { help, type: 'gauge' });
}

function incrCounter(name, labels = {}, val = 1) {
    const key = _makeKey(name, labels);
    counters.set(key, (counters.get(key) || 0) + val);
}

function setGauge(name, labels = {}, val) {
    const key = _makeKey(name, labels);
    gauges.set(key, val);
}

function render() {
    const lines = [];
    // Group entries by base metric name so HELP/TYPE appear once per metric.
    const byName = new Map();
    for (const [key, val] of counters) {
        const baseName = key.split('{')[0];
        if (!byName.has(baseName)) byName.set(baseName, []);
        byName.get(baseName).push({ key, val });
    }
    for (const [key, val] of gauges) {
        const baseName = key.split('{')[0];
        if (!byName.has(baseName)) byName.set(baseName, []);
        byName.get(baseName).push({ key, val });
    }

    for (const [baseName, entries] of byName) {
        const meta = metricMeta.get(baseName);
        if (meta) {
            lines.push(`# HELP ${baseName} ${meta.help}`);
            lines.push(`# TYPE ${baseName} ${meta.type}`);
        }
        for (const { key, val } of entries) {
            lines.push(`${key} ${val}`);
        }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
    registerCounter,
    registerGauge,
    incrCounter,
    setGauge,
    render,
};
