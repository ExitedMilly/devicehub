'use strict';

const { spawn } = require('child_process');

function runAdb(serial, args, options = {}) {
    const { allowFailure = false, timeoutMs = 10000 } = options;

    return new Promise((resolve, reject) => {
        const child = spawn('adb', ['-s', serial, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                child.kill('SIGKILL');
            } catch {}
            reject(new Error(`adb timeout after ${timeoutMs}ms: adb -s ${serial} ${args.join(' ')}`));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            const result = {
                ok: code === 0,
                code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
            };

            if (code === 0 || allowFailure) {
                resolve(result);
                return;
            }

            reject(
                new Error(
                    `adb failed (code ${code}): adb -s ${serial} ${args.join(' ')}\n` +
                    (stderr.trim() || stdout.trim() || 'no output')
                )
            );
        });
    });
}

module.exports = { runAdb };
