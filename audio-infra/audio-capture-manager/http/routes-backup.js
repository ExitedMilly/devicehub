'use strict';

const backupLogical = require('../domain/backup-logical');
const log = require('../log').getLogger('http/routes-backup');

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
                log.error({ serial, err: err.message }, 'Restore failed');
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
                log.error({ serial, err: err.message }, 'Backup create failed');
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handleBackup };
