import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import type { DeviceBackupStore } from '@/store/device-backup-store'

import topBarStyles from './device-top-bar.module.css'
import styles from './backup-button.module.css'

export const BackupButton = observer(() => {
  const backupStore = useInjection<DeviceBackupStore>(CONTAINER_IDS.deviceBackupStore)
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      void backupStore.refreshStatus()
    }
  }, [isOpen, backupStore])

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
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        title='Backup / restore emulator state'
        onClick={() => setIsOpen(open => !open)}
      >
        Backup
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.sectionTitle}>Emulator backup</div>
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
        </div>
      )}
    </div>
  )
})
