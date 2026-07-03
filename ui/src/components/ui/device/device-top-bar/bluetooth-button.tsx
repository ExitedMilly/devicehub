import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { CSSProperties } from 'react'

// Green "active" look on the trigger when the adapter is ON (like active scenarios).
const TRIGGER_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}

export const BluetoothButton = observer(() => {
  const bluetoothStore = useInjection(CONTAINER_IDS.deviceBluetoothStore)
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

  // Sync the current on/off state from the device when the popover opens.
  useEffect(() => {
    if (isOpen) void bluetoothStore.fetchStatus()
  }, [isOpen, bluetoothStore])

  return (
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        style={bluetoothStore.enabled ? TRIGGER_ACTIVE : undefined}
        title='Bluetooth'
        onClick={() => setIsOpen(open => !open)}
      >
        Bluetooth
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='bluetooth-toggle'>Bluetooth</label>
            <Switch
              checked={bluetoothStore.enabled}
              disabled={bluetoothStore.isApplying}
              id='bluetooth-toggle'
              onChange={(event) => { void bluetoothStore.setEnabled(event.target.checked) }}
            />
          </div>

          {bluetoothStore.statusText && (
            <div className={bluetoothStore.errorMessage ? styles.error : styles.status}>
              {bluetoothStore.isApplying ? 'Applying...' : bluetoothStore.statusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
