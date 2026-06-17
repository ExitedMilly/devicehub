'use strict';

const { runAdb } = require('../adb-runner');
const { batteryStates } = require('../stores');
const log = require('../log').getLogger('domain/battery');

function validateLevel(level) {
    const value = Number(level);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('level must be a number between 0 and 100');
    }
    return Math.round(value);
}

// Парсинг вывода `adb shell dumpsys battery`.
// capacity берём из строки `level:`, charging — любой источник питания включён, status/health — сырые int.
function parseDumpsysBattery(stdout) {
    const text = String(stdout || '');
    const numLine = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
    const boolLine = (re) => { const m = text.match(re); return m ? /true/i.test(m[1]) : false; };

    const ac = boolLine(/AC powered:\s*(true|false)/i);
    const usb = boolLine(/USB powered:\s*(true|false)/i);
    const wireless = boolLine(/Wireless powered:\s*(true|false)/i);

    return {
        capacity: numLine(/^\s*level:\s*(\d+)/im),
        charging: ac || usb || wireless,
        status: numLine(/^\s*status:\s*(\d+)/im),
        health: numLine(/^\s*health:\s*(\d+)/im),
    };
}

async function getBatteryState(serial) {
    const result = await runAdb(serial, ['shell', 'dumpsys', 'battery']);
    const parsed = parseDumpsysBattery(result.stdout);
    batteryStates.set(serial, parsed);
    return parsed;
}

async function applyBattery(serial, { level, charging } = {}) {
    if (level !== undefined && level !== null) {
        await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'level', String(validateLevel(level))]);
    }
    if (charging !== undefined && charging !== null) {
        if (charging) {
            await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'ac', '1']);
            await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'status', '2']); // 2 = CHARGING
        } else {
            await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'ac', '0']);
            await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'usb', '0']);
            await runAdb(serial, ['shell', 'dumpsys', 'battery', 'set', 'status', '3']); // 3 = DISCHARGING
        }
    }
    return getBatteryState(serial);
}

function setBatteryLevel(serial, level) {
    return applyBattery(serial, { level });
}

function setBatteryCharging(serial, charging) {
    return applyBattery(serial, { charging });
}

// Вернуть реальную батарею (снять dumpsys-override, переоткрыть обновления ОС). Роут пока не использует — задел.
async function resetBattery(serial) {
    await runAdb(serial, ['shell', 'dumpsys', 'battery', 'reset']);
    return getBatteryState(serial);
}

module.exports = { applyBattery, setBatteryLevel, setBatteryCharging, getBatteryState, resetBattery };
