// audio-infra/audio-capture-manager/backup-logical.js
//
// Logical emulator backup / restore.
//
// BACKUP: dumps installed 3rd-party APKs + /sdcard/ into a single tar.gz on
// the host. Does NOT capture app user data (would need root).
//
// RESTORE: reinstalls APKs via `adb install[-multiple] -r` and pushes
// /sdcard/ contents back. Does NOT wipe pre-existing packages or files that
// are not part of the backup. Pre-existing files at the same path ARE
// overwritten with backup content.
//
// Lock: one operation at a time per serial (backup OR restore). Flag is
// in-memory and cleared in `finally`, survives clients disconnecting.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const log = require('../log').getLogger('domain/backup-logical');

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

// Packages that are part of the DeviceHub/STF infrastructure, not user apps.
// Must NEVER be backed up or reinstalled: reinstalling the agent restarts it
// and surfaces it on screen, and it's provisioned by the stack anyway.
const BACKUP_EXCLUDED_PACKAGES = [
    'jp.co.cyberagent.stf',        // STFService — DeviceHub on-device agent
    'jp.co.cyberagent.stf.input',  // STF input agent (if present)
];

const ADB_QUICK_TIMEOUT_MS      = 10_000;
const ADB_APK_PULL_TIMEOUT_MS   = 120_000;
const ADB_APK_INSTALL_TIMEOUT_MS = 180_000;
const ADB_SDCARD_TAR_TIMEOUT_MS = 600_000;
const ADB_SDCARD_PUSH_TIMEOUT_MS = 600_000;
const OVERALL_TIMEOUT_MS        = 30 * 60 * 1000;

// Unified operation state map. Key = serial, value = {kind, stage, ...progress}.
// Enforces backup+restore mutual exclusion naturally.
const _activeOps = new Map();

// ---------------------- helpers ----------------------

function backupFilePath(serial) {
    const safe = serial.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(BACKUP_DIR, safe + '.tar.gz');
}

function humanSize(bytes) {
    if (!bytes || bytes <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { /* ignore */ }
}

function runAdb(args, timeoutMs) {
    return new Promise(function(resolve, reject) {
        execFile('adb', args, {
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
        }, function(err, stdout, stderr) {
            if (err) {
                return reject(new Error(
                    'adb ' + args.slice(0, 3).join(' ') + ' failed: ' + err.message +
                    (stderr ? ' [' + String(stderr).trim().slice(0, 200) + ']' : '')
                ));
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

// ---------------------- adb: backup-side operations ----------------------

async function listThirdPartyPackages(serial) {
    const result = await runAdb(
        ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'],
        ADB_QUICK_TIMEOUT_MS
    );
    return result.stdout.split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l.startsWith('package:'); })
        .map(function(l) { return l.substring('package:'.length); })
        .filter(Boolean)
        .filter(function(pkg) { return !BACKUP_EXCLUDED_PACKAGES.includes(pkg); });
}

async function getApkPaths(serial, packageName) {
    const result = await runAdb(
        ['-s', serial, 'shell', 'pm', 'path', packageName],
        ADB_QUICK_TIMEOUT_MS
    );
    return result.stdout.split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l.startsWith('package:'); })
        .map(function(l) { return l.substring('package:'.length); });
}

async function pullFile(serial, remotePath, localPath) {
    await runAdb(
        ['-s', serial, 'pull', remotePath, localPath],
        ADB_APK_PULL_TIMEOUT_MS
    );
}

async function pullSdcardTarball(serial, localTarPath) {
    return new Promise(function(resolve, reject) {
        let settled = false;
        let stderrBuf = '';
        let childExited = false;
        let childExitCode = null;
        let outFinished = false;
        let bytesWritten = 0;

        const out = fs.createWriteStream(localTarPath);
        // Inside emulator: tar /sdcard/, excluding Android (app cache) and trash.
        const shellCmd = 'cd /sdcard && tar --exclude=./Android --exclude=./.Trash-* -cf - ./ 2>/dev/null; exit 0';

        const proc = spawn('adb', ['-s', serial, 'exec-out', 'sh', '-c', shellCmd], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        function settle(err) {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            if (err) reject(err); else resolve({ bytes: bytesWritten });
        }

        function tryFinish() {
            if (!childExited || !outFinished) return;
            if (childExitCode === 0 || bytesWritten > 0) settle();
            else settle(new Error('adb exec-out tar failed (code ' + childExitCode + '): ' + stderrBuf.slice(-300)));
        }

        proc.stderr.on('data', function(c) { stderrBuf += c.toString(); });
        proc.stdout.on('data', function(c) { bytesWritten += c.length; });
        proc.stdout.pipe(out);

        out.on('finish', function() { outFinished = true; tryFinish(); });
        out.on('error',  function(e) { settle(e); });
        proc.on('error', function(e) { settle(e); });
        proc.on('close', function(code) { childExited = true; childExitCode = code; tryFinish(); });

        const killTimer = setTimeout(function() {
            try { proc.kill('SIGKILL'); } catch (e) {}
            try { out.destroy(); } catch (e) {}
            settle(new Error('adb exec-out tar /sdcard timed out after ' + ADB_SDCARD_TAR_TIMEOUT_MS + 'ms'));
        }, ADB_SDCARD_TAR_TIMEOUT_MS);
    });
}

async function makeTarGz(srcDir, outPath) {
    return new Promise(function(resolve, reject) {
        let settled = false;
        let stderrBuf = '';
        let childExited = false;
        let childExitCode = null;
        let outFinished = false;

        const out = fs.createWriteStream(outPath);
        const proc = spawn('tar', ['czf', '-', '-C', srcDir, '.'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        function settle(err) {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve();
        }
        function tryFinish() {
            if (!childExited || !outFinished) return;
            if (childExitCode === 0) settle();
            else settle(new Error('tar czf failed (code ' + childExitCode + '): ' + stderrBuf.slice(-300)));
        }

        proc.stderr.on('data', function(c) { stderrBuf += c.toString(); });
        proc.stdout.pipe(out);

        out.on('finish', function() { outFinished = true; tryFinish(); });
        out.on('error',  function(e) { settle(e); });
        proc.on('error', function(e) { settle(e); });
        proc.on('close', function(code) {
            childExited = true;
            childExitCode = code;
            if (code !== 0) {
                try { out.destroy(); } catch (e) {}
                settle(new Error('tar czf failed (code ' + code + '): ' + stderrBuf.slice(-300)));
                return;
            }
            tryFinish();
        });
    });
}

// ---------------------- adb: restore-side operations ----------------------

// Extract a tar.gz to a staging directory.
async function extractTarGz(srcTarGz, destDir) {
    return new Promise(function(resolve, reject) {
        let stderrBuf = '';
        const proc = spawn('tar', ['xzf', srcTarGz, '-C', destDir], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        proc.stderr.on('data', function(c) { stderrBuf += c.toString(); });
        proc.on('error', reject);
        proc.on('close', function(code) {
            if (code === 0) resolve();
            else reject(new Error('tar xzf failed (' + code + '): ' + stderrBuf.slice(-300)));
        });
    });
}

// Install one package from its local apk path(s).
// Returns {ok, error?} — never throws; errors go into manifest.
async function installApk(serial, apkPaths) {
    try {
        if (apkPaths.length === 1) {
            await runAdb(
                ['-s', serial, 'install', '-r', '-g', apkPaths[0]],
                ADB_APK_INSTALL_TIMEOUT_MS
            );
        } else {
            await runAdb(
                ['-s', serial, 'install-multiple', '-r', '-g'].concat(apkPaths),
                ADB_APK_INSTALL_TIMEOUT_MS
            );
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Push a local directory tree to /sdcard/ on the emulator.
// Uses `adb push <localDir>/. /sdcard/` — content merge semantics, does not
// delete existing files.
async function pushSdcardDir(serial, localDir) {
    // If extracted sdcard tar is empty or missing, skip.
    let hasContent = false;
    try {
        const entries = fs.readdirSync(localDir);
        hasContent = entries.length > 0;
    } catch (e) { /* dir missing */ }
    if (!hasContent) return { bytes: 0, skipped: true };

    return new Promise(function(resolve, reject) {
        let settled = false;
        let stderrBuf = '';

        // Trailing /. means "copy contents of localDir into /sdcard/", not
        // "copy localDir itself as a subdir".
        const proc = spawn('adb', ['-s', serial, 'push', localDir + '/.', '/sdcard/'], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        function settle(err) {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            if (err) reject(err); else resolve({ skipped: false });
        }

        proc.stderr.on('data', function(c) { stderrBuf += c.toString(); });
        proc.on('error', function(e) { settle(e); });
        proc.on('close', function(code) {
            if (code === 0) settle();
            else settle(new Error('adb push /sdcard failed (' + code + '): ' + stderrBuf.slice(-400)));
        });

        const killTimer = setTimeout(function() {
            try { proc.kill('SIGKILL'); } catch (e) {}
            settle(new Error('adb push /sdcard timed out after ' + ADB_SDCARD_PUSH_TIMEOUT_MS + 'ms'));
        }, ADB_SDCARD_PUSH_TIMEOUT_MS);
    });
}

// ---------------------- backup (unchanged, just uses _activeOps) ----------------------

async function createBackup(serial) {
    if (_activeOps.has(serial)) {
        const op = _activeOps.get(serial);
        throw new Error(op.kind + ' already in progress for ' + serial);
    }
    const state = { kind: 'backup', startedAt: Date.now(), stage: 'starting' };
    _activeOps.set(serial, state);

    const t0 = Date.now();
    log.info({ serial }, 'Starting logical backup');

    try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devicehub_backup_'));
    const apksDir = path.join(stagingDir, 'apks');
    fs.mkdirSync(apksDir, { recursive: true });

    const manifest = {
        serial: serial,
        createdAt: new Date().toISOString(),
        packages: [],
        sdcardTarBytes: 0,
        errors: [],
    };

    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    function checkDeadline() {
        if (Date.now() > deadline) throw new Error('Backup exceeded overall timeout');
    }

    try {
        state.stage = 'listing';
        const packages = await listThirdPartyPackages(serial);
        log.info({ serial, count: packages.length }, 'Found 3rd-party packages');

        state.stage = 'apks';
        state.totalPackages = packages.length;
        state.donePackages = 0;

        for (let i = 0; i < packages.length; i++) {
            checkDeadline();
            const pkg = packages[i];
            state.currentPackage = pkg;
            try {
                const apkPaths = await getApkPaths(serial, pkg);
                const pkgEntry = { name: pkg, apks: [] };
                for (let j = 0; j < apkPaths.length; j++) {
                    const remote = apkPaths[j];
                    const localName = pkg + (apkPaths.length > 1 ? '__' + j : '') + '.apk';
                    const localPath = path.join(apksDir, localName);
                    await pullFile(serial, remote, localPath);
                    let sizeBytes = 0;
                    try { sizeBytes = fs.statSync(localPath).size; } catch (e) {}
                    pkgEntry.apks.push({ localName: localName, sizeBytes: sizeBytes });
                }
                manifest.packages.push(pkgEntry);
            } catch (err) {
                log.warn({ serial, pkg, err: err.message }, 'Failed to pull package');
                manifest.errors.push({ stage: 'apk', package: pkg, error: err.message });
            }
            state.donePackages = i + 1;
        }

        checkDeadline();
        state.stage = 'sdcard';
        state.currentPackage = null;
        const sdcardTarPath = path.join(stagingDir, 'sdcard.tar');
        try {
            const r = await pullSdcardTarball(serial, sdcardTarPath);
            manifest.sdcardTarBytes = r.bytes;
            log.info({ serial, size: humanSize(r.bytes) }, '/sdcard tarball done');
        } catch (err) {
            log.warn({ serial, err: err.message }, '/sdcard tarball failed');
            manifest.errors.push({ stage: 'sdcard', error: err.message });
        }

        fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        state.stage = 'packaging';
        const outPath = backupFilePath(serial);
        const tmpOutPath = outPath + '.tmp';
        try { fs.unlinkSync(tmpOutPath); } catch (e) {}
        await makeTarGz(stagingDir, tmpOutPath);
        fs.renameSync(tmpOutPath, outPath);

        const finalStat = fs.statSync(outPath);
        const elapsedMs = Date.now() - t0;
        log.info({ serial, size: humanSize(finalStat.size), elapsedMs }, 'Backup saved');

        return {
            serial: serial,
            path: outPath,
            elapsedMs: elapsedMs,
            savedAt: manifest.createdAt,
            sizeBytes: finalStat.size,
            sizeLabel: humanSize(finalStat.size),
            packageCount: manifest.packages.length,
            errorCount: manifest.errors.length,
        };
    } finally {
        rmrf(stagingDir);
        _activeOps.delete(serial);
    }
}

// ---------------------- restore ----------------------

async function restoreBackup(serial) {
    if (_activeOps.has(serial)) {
        const op = _activeOps.get(serial);
        throw new Error(op.kind + ' already in progress for ' + serial);
    }
    const state = { kind: 'restore', startedAt: Date.now(), stage: 'starting' };
    _activeOps.set(serial, state);

    const t0 = Date.now();
    const backupPath = backupFilePath(serial);
    log.info({ serial, backupPath }, 'Starting restore');

    // Fail fast if file missing / not readable
    if (!fs.existsSync(backupPath)) {
        _activeOps.delete(serial);
        throw new Error('Backup file not found: ' + backupPath);
    }

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devicehub_restore_'));

    const report = {
        serial: serial,
        startedAt: new Date().toISOString(),
        backupCreatedAt: null,
        packagesInstalled: 0,
        packagesFailed: 0,
        sdcardRestored: false,
        errors: [],
    };

    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    function checkDeadline() {
        if (Date.now() > deadline) throw new Error('Restore exceeded overall timeout');
    }

    try {
        state.stage = 'extracting';
        await extractTarGz(backupPath, stagingDir);

        // Read manifest
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(stagingDir, 'manifest.json'), 'utf8'));
            report.backupCreatedAt = manifest.createdAt || null;
        } catch (err) {
            throw new Error('Could not read manifest.json from backup: ' + err.message);
        }

        const apksDir = path.join(stagingDir, 'apks');
        const packages = Array.isArray(manifest.packages) ? manifest.packages : [];

        // --- install APKs ---
        state.stage = 'installing';
        state.totalPackages = packages.length;
        state.donePackages = 0;

        for (let i = 0; i < packages.length; i++) {
            checkDeadline();
            const pkg = packages[i];
            if (BACKUP_EXCLUDED_PACKAGES.includes(pkg.name)) {
                log.info({ serial, pkg: pkg.name }, 'Skipping excluded infrastructure package on restore');
                state.donePackages = i + 1;
                continue;
            }
            state.currentPackage = pkg.name;

            const apkFiles = (pkg.apks || [])
                .map(function(a) { return path.join(apksDir, a.localName); })
                .filter(function(p) { return fs.existsSync(p); });

            if (apkFiles.length === 0) {
                report.errors.push({ stage: 'install', package: pkg.name, error: 'no apk files in backup' });
                report.packagesFailed++;
                state.donePackages = i + 1;
                continue;
            }

            log.info({ serial, pkg: pkg.name, apkCount: apkFiles.length }, 'Installing package');
            const r = await installApk(serial, apkFiles);
            if (r.ok) {
                report.packagesInstalled++;
            } else {
                log.warn({ serial, pkg: pkg.name, err: r.error }, 'Install failed');
                report.errors.push({ stage: 'install', package: pkg.name, error: r.error });
                report.packagesFailed++;
            }
            state.donePackages = i + 1;
        }

        // --- restore /sdcard ---
        checkDeadline();
        state.stage = 'sdcard';
        state.currentPackage = null;
        const sdcardTarInBackup = path.join(stagingDir, 'sdcard.tar');
        if (fs.existsSync(sdcardTarInBackup)) {
            const sdcardDir = path.join(stagingDir, 'sdcard_extracted');
            fs.mkdirSync(sdcardDir, { recursive: true });
            try {
                // Extract sdcard.tar locally first, then push whole dir in one go
                await new Promise(function(resolve, reject) {
                    let stderrBuf = '';
                    const proc = spawn('tar', ['xf', sdcardTarInBackup, '-C', sdcardDir], {
                        stdio: ['ignore', 'ignore', 'pipe'],
                    });
                    proc.stderr.on('data', function(c) { stderrBuf += c.toString(); });
                    proc.on('error', reject);
                    proc.on('close', function(code) {
                        if (code === 0) resolve();
                        else reject(new Error('sdcard tar extract failed (' + code + '): ' + stderrBuf.slice(-300)));
                    });
                });

                const pushResult = await pushSdcardDir(serial, sdcardDir);
                if (!pushResult.skipped) {
                    report.sdcardRestored = true;
                } else {
                    log.info({ serial }, 'sdcard was empty in backup, nothing to push');
                }
            } catch (err) {
                log.warn({ serial, err: err.message }, '/sdcard push failed');
                report.errors.push({ stage: 'sdcard', error: err.message });
            }
        } else {
            log.info({ serial }, 'No sdcard.tar in backup, skipping');
        }

        const elapsedMs = Date.now() - t0;
        report.elapsedMs = elapsedMs;
        report.finishedAt = new Date().toISOString();

        log.info({ serial, elapsedMs, installed: report.packagesInstalled, total: packages.length, sdcard: report.sdcardRestored, errors: report.errors.length }, 'Restore done');

        return report;
    } finally {
        rmrf(stagingDir);
        _activeOps.delete(serial);
    }
}

// ---------------------- status ----------------------

function getBackupStatus(serial) {
    const active = _activeOps.get(serial) || null;
    const outPath = backupFilePath(serial);
    let fileInfo;
    try {
        const st = fs.statSync(outPath);
        fileInfo = {
            exists: true,
            sizeBytes: st.size,
            sizeLabel: humanSize(st.size),
            mtime: st.mtime.toISOString(),
        };
    } catch (e) {
        fileInfo = { exists: false };
    }
    return {
        serial: serial,
        exists: !!fileInfo.exists,
        sizeBytes: fileInfo.sizeBytes || null,
        sizeLabel: fileInfo.sizeLabel || null,
        createdAt: fileInfo.mtime || null,
        inProgress: !!active,
        operationKind: active ? active.kind : null,       // 'backup' | 'restore' | null
        progressStage: active ? active.stage : null,
        progressDone: active ? (active.donePackages || null) : null,
        progressTotal: active ? (active.totalPackages || null) : null,
        currentPackage: active ? (active.currentPackage || null) : null,
        error: null,
    };
}

module.exports = {
    createBackup: createBackup,
    restoreBackup: restoreBackup,
    getBackupStatus: getBackupStatus,
    BACKUP_DIR: BACKUP_DIR,
};
