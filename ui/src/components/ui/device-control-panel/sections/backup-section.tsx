import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Icon28ArchiveOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

import type { DeviceBackupStore } from '@/store/device-backup-store'

/**
 * "Backup" operblock block — snapshot/restore of installed 3rd-party APKs + /sdcard/
 * contents. Uses the per-device deviceBackupStore. Green dot = a backup exists.
 */
export const BackupSection = observer(() => {
  const backupStore = useInjection<DeviceBackupStore>(CONTAINER_IDS.deviceBackupStore)

  useEffect(() => {
    void backupStore.refreshStatus()
  }, [backupStore])

  const handleCreate = (): void => {
    if (backupStore.backend?.exists) {
      const ok = window.confirm('Overwrite previous backup? The existing backup will be replaced.')
      if (!ok) return
    }
    void backupStore.createBackup()
  }

  const handleRestore = (): void => {
    const ok = window.confirm(
      'Restore from backup?\n\n' +
      'This will reinstall APKs from the backup and push /sdcard/ contents ' +
      'back to the emulator. Existing installed packages NOT in the backup ' +
      'will remain. Existing /sdcard/ files will be overwritten if they are ' +
      'in the backup.'
    )
    if (!ok) return
    void backupStore.restoreBackup()
  }

  return (
    <PanelSection active={!!backupStore.backend?.exists} icon={<Icon28ArchiveOutline />} title='Backup'>
      <div className={styles.hint}>
        Saves installed 3rd-party APKs and <code>/sdcard/</code> contents.
        App data (accounts, settings) is NOT captured. Running Create again
        overwrites the previous backup.
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={backupStore.isBusy}
          type='button'
          onClick={handleCreate}
        >
          {backupStore.isCreating ? 'Creating...' : 'Create backup'}
        </button>

        <button
          className={styles.restoreButton}
          disabled={!backupStore.canRestore}
          type='button'
          onClick={handleRestore}
          title={backupStore.canRestore ? 'Restore from backup' : 'No backup to restore from'}
        >
          {backupStore.isRestoring ? 'Restoring...' : 'Restore'}
        </button>
      </div>

      {backupStore.statusText && (
        <div className={backupStore.errorMessage ? styles.error : styles.status}>
          {backupStore.statusText}
        </div>
      )}
    </PanelSection>
  )
})
