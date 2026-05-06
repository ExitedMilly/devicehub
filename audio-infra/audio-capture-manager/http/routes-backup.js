'use strict';

const backupLogical = require('../domain/backup-logical');

function handleBackup(req, res, url) {
    const backupRestoreMatch = url.pathname.match(/^\/api\/backup\/(.+)\/restore$/);
    if (req.method === 'POST' && backupRestoreMatch) {
        const serial = decodeURIComponent(backupRestoreMatch[1]);
        backupLogical.restoreBackup(serial)
            .then(function(report) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, report: report }));
            })
            .catch(function(err) {
                console.error('[restore] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    const backupStatusMatch = url.pathname.match(/^\/api\/backup\/(.+)\/status$/);
    if (req.method === 'GET' && backupStatusMatch) {
        const serial = decodeURIComponent(backupStatusMatch[1]);
        try {
            const status = backupLogical.getBackupStatus(serial);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, serial: serial, status: status }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return true;
    }

    const backupCreateMatch = url.pathname.match(/^\/api\/backup\/(.+)$/);
    if (req.method === 'POST' && backupCreateMatch) {
        const serial = decodeURIComponent(backupCreateMatch[1]);
        backupLogical.createBackup(serial)
            .then(function(result) {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, result: result }));
            })
            .catch(function(err) {
                console.error('[backup] Failed for ' + serial + ': ' + err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleBackup };
