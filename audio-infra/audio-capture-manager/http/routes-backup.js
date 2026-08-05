'use strict';

const backupLogical = require('../domain/backup-logical');
const log = require('../log').getLogger('http/routes-backup');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /backup/{serial}:
 *   post:
 *     tags: [backup]
 *     operationId: createBackup
 *     summary: Create a logical backup of installed apps and /sdcard
 *     description: |
 *       **Live device.** Pulls every third-party APK plus the contents of `/sdcard` off the
 *       device and writes a single archive on the host under `BACKUP_DIR`. An existing archive for
 *       the serial is replaced.
 *
 *       **This takes minutes, not seconds** — it is bounded by a 30 minute overall deadline, with
 *       sub-timeouts of 2 minutes per APK pull, 10 minutes for the `/sdcard` tar and 10 minutes for
 *       the push on restore. Clients must use a matching timeout or poll
 *       `GET /backup/{serial}/status` instead of blocking on this call. Only one backup or restore
 *       may run per serial at a time; a second call is rejected while one is in flight.
 *
 *       Scope limits worth knowing: app *user data* is not captured (that needs root), and the
 *       DeviceHub on-device agent packages are deliberately excluded so a restore cannot reinstall
 *       and restart them.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Backup written.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BackupResult' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500':
 *         description: |
 *           Backup failed, timed out, or another backup/restore is already running for this serial.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             examples:
 *               busy:
 *                 value: { ok: false, error: 'backup already in progress for emulator-test3:5555' }
 *               timeout:
 *                 value: { ok: false, error: 'Backup exceeded overall timeout' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /backup/{serial}/status:
 *   get:
 *     tags: [backup]
 *     operationId: getBackupStatus
 *     summary: Inspect the stored backup and any operation in flight
 *     description: |
 *       Read-only and cheap. Reports whether an archive exists for the serial (size, creation
 *       time) and, when a backup or restore is running, its stage and progress. This is the
 *       endpoint to poll while a long operation is in flight, rather than holding the create or
 *       restore request open.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: Backup status.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BackupStatus' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500': { $ref: '#/components/responses/ServerError' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 * /backup/{serial}/restore:
 *   post:
 *     tags: [backup]
 *     operationId: restoreBackup
 *     summary: Reinstall apps and push /sdcard back from the stored backup
 *     description: |
 *       **Live device, and the most invasive call in this API.** Reinstalls every APK from the
 *       archive and pushes the stored `/sdcard` contents onto the device.
 *
 *       **This takes minutes**, same deadlines as creating a backup, and one backup or restore at
 *       a time per serial.
 *
 *       Restore semantics are additive, not a wipe: packages and files that exist on the device
 *       but not in the archive are left alone, while files at the same path are overwritten. The
 *       DeviceHub agent packages are skipped here too. A missing archive fails fast.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: |
 *           Restore finished. Individual packages may still have failed — check
 *           `report.packagesFailed` and `report.errors`, not just the status code.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/BackupRestoreReport' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '500':
 *         description: No archive for this serial, restore failed, or an operation is already running.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'Backup file not found: /backups/emulator-test3_5555.tar.gz' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handleBackup(req, res, url) {
    const backupRestoreMatch = url.pathname.match(/^\/api\/backup\/(.+)\/restore$/);
    if (req.method === 'POST' && backupRestoreMatch) {
        const serial = decodeURIComponent(backupRestoreMatch[1]);
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
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
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
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
        if (!isSerialAllowed(serial)) {
            log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
            return true;
        }
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
