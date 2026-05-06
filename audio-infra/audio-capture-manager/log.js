'use strict';

const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_PRETTY = process.env.LOG_PRETTY === '1';

const baseLogger = pino({
    level: LOG_LEVEL,
    ...(LOG_PRETTY ? {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
            },
        },
    } : {}),
});

function getLogger(module) {
    return baseLogger.child({ module });
}

module.exports = { getLogger, baseLogger };
