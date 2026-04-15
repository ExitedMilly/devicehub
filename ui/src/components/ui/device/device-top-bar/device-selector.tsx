import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'

import type { MediaDeviceInfo } from '@/store/device-media-devices-store'

import styles from './device-selector.module.css'

interface DeviceSelectorProps {
  devices: MediaDeviceInfo[]
  selectedDeviceId: string | null
  onSelect: (deviceId: string) => void
  disabled?: boolean
  emptyMessage?: string
  onRequestAccess?: () => void | Promise<void>
}

export const DeviceSelector = observer(({
  devices,
  selectedDeviceId,
  onSelect,
  disabled,
  emptyMessage = 'No devices found yet.',
  onRequestAccess,
}: DeviceSelectorProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen])

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        className={styles.trigger}
        disabled={disabled}
        title='Select device'
        type='button'
        onClick={() => setIsOpen(open => !open)}
      >
        <svg fill='currentColor' height='10' viewBox='0 0 10 6' width='10'>
          <path d='M1 1l4 4 4-4' fill='none' stroke='currentColor' strokeLinecap='round' strokeWidth='1.5' />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          {devices.length > 0 ? (
            devices.map(device => (
              <button
                className={`${styles.option} ${device.deviceId === selectedDeviceId ? styles.selected : ''}`}
                key={device.deviceId}
                type='button'
                onClick={() => {
                  onSelect(device.deviceId)
                  setIsOpen(false)
                }}
              >
                <span className={styles.check}>{device.deviceId === selectedDeviceId ? '✓' : ''}</span>
                <span className={styles.label} title={device.label}>{device.label}</span>
              </button>
            ))
          ) : (
            <div className={styles.emptyState}>
              <div className={styles.emptyMessage}>{emptyMessage}</div>
              {onRequestAccess && (
                <button
                  className={styles.accessButton}
                  type='button'
                  onClick={async () => {
                    await onRequestAccess()
                  }}
                >
                  Grant access and refresh
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})