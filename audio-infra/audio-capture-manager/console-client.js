'use strict';

const net = require('net');
const fs = require('fs');
const { EMULATOR_ADB_HOST, ADB_PORT } = require('./config');

// Path to the emulator console auth token (written by the emulator on startup).
const TOKEN_FILE = process.env.CONSOLE_AUTH_TOKEN_FILE || '/run/console-token';

// Resolve the telnet console host/port from a serial.
// The console port is the ADB port minus 1 (e.g. adb 5555 -> console 5554).
//  - serial "host:port"  -> host = host part, consolePort = port - 1
//  - serial without port -> host = EMULATOR_ADB_HOST, consolePort = ADB_PORT - 1
function resolveConsoleTarget(serial) {
    const s = String(serial || '');
    const idx = s.lastIndexOf(':');
    if (idx > -1) {
        const host = s.slice(0, idx);
        const adbPort = parseInt(s.slice(idx + 1), 10);
        if (host && Number.isFinite(adbPort)) {
            return { host, port: adbPort - 1 };
        }
    }
    const host = EMULATOR_ADB_HOST || s || 'localhost';
    const adbPort = Number.isFinite(ADB_PORT) ? ADB_PORT : 5555;
    return { host, port: adbPort - 1 };
}

// A console response is terminated by a line that (after trim) equals 'OK'
// or starts with 'KO'. Extract one complete response from the buffer; return
// null if no terminator line has fully arrived yet.
function tryExtractResponse(buf) {
    const lines = buf.split(/\r?\n/);
    const endsWithNewline = /\r?\n$/.test(buf);
    for (let i = 0; i < lines.length; i++) {
        const isLast = i === lines.length - 1;
        // The final element may be a partial line if the buffer does not end
        // on a newline - don't treat it as a terminator yet.
        if (isLast && !endsWithNewline) break;
        const t = lines[i].trim();
        if (t === 'OK' || t.startsWith('KO')) {
            return {
                output: lines.slice(0, i),
                terminatorLine: t,
                rest: lines.slice(i + 1).join('\n'),
            };
        }
    }
    return null;
}

// Open a fresh authenticated console connection, run the given commands in
// order, and resolve with { ok: true, outputs: string[] } where outputs[i] is
// the raw output of commands[i] (the lines before its OK/KO terminator).
// A new connection is opened per call - console commands are infrequent.
async function consoleExec(serial, commands, { timeoutMs = 8000 } = {}) {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const { host, port } = resolveConsoleTarget(serial);

    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);

        let buf = '';
        let stage = 'banner'; // banner -> auth -> cmd
        let cmdIndex = 0;
        const outputs = [];
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) { /* ignore */ }
            reject(new Error('console timeout: ' + commands.join(' | ')));
        }, timeoutMs);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.write('quit\r\n'); } catch (e) { /* ignore */ }
            try { socket.destroy(); } catch (e) { /* ignore */ }
            if (err) reject(err); else resolve(value);
        }

        socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');

            let res;
            while ((res = tryExtractResponse(buf)) !== null) {
                buf = res.rest;
                const isKO = res.terminatorLine.startsWith('KO');

                if (stage === 'banner') {
                    // Banner consumed - authenticate.
                    stage = 'auth';
                    socket.write('auth ' + token + '\r\n');
                } else if (stage === 'auth') {
                    if (isKO) {
                        finish(new Error('console auth failed: ' + res.terminatorLine));
                        return;
                    }
                    stage = 'cmd';
                    if (commands.length === 0) {
                        finish(null, { ok: true, outputs: [] });
                        return;
                    }
                    socket.write(commands[0] + '\r\n');
                } else if (stage === 'cmd') {
                    outputs.push(res.output.join('\n'));
                    cmdIndex++;
                    if (cmdIndex >= commands.length) {
                        finish(null, { ok: true, outputs });
                        return;
                    }
                    socket.write(commands[cmdIndex] + '\r\n');
                }
            }
        });

        socket.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });

        socket.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error('console connection closed before completion'));
        });
    });
}

module.exports = { consoleExec };
