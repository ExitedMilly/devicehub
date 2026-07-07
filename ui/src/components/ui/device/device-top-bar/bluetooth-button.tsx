import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { CSSProperties } from 'react'
import type { BleBeacon } from '@/store/device-ble-beacon-store'

// Green "active" look on the trigger when the adapter is ON (like active scenarios).
const TRIGGER_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}
const BEACON_TITLE_ROW: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const BEACON_META: CSSProperties = { fontSize: 12, color: 'var(--vkui--color_text_secondary)', wordBreak: 'break-all' }

// One-line summary of a beacon's advertised data.
function beaconSummary(b: BleBeacon): string {
  const parts: string[] = []
  if (b.manufacturerData) parts.push(`mfg ${b.manufacturerData}`)
  for (const s of b.services) if (s.uuid) parts.push(`svc ${s.uuid.slice(0, 8)}`)
  if (b.txPowerLevel) parts.push(`TX ${b.txPowerLevel}`)
  else if (b.dbm != null) parts.push(`${b.dbm} dBm`)
  if (b.advertiseMode) parts.push(b.advertiseMode)
  else if (b.intervalMs != null) parts.push(`${b.intervalMs} ms`)
  if (b.includeDeviceName) parts.push('name')
  return parts.join(' · ') || 'no advertise data'
}

export const BluetoothButton = observer(() => {
  const bluetoothStore = useInjection(CONTAINER_IDS.deviceBluetoothStore)
  const bleBeaconStore = useInjection(CONTAINER_IDS.deviceBleBeaconStore)
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

  // Load the current fake BLE beacons from netsim when the popover opens.
  useEffect(() => {
    if (isOpen) void bleBeaconStore.fetch()
  }, [isOpen, bleBeaconStore])

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

          {/* ============== BLE beacons (read-only) ============== */}

          <hr className={styles.divider} />

          <div className={styles.sectionTitle} style={BEACON_TITLE_ROW}>
            <span>BLE beacons</span>
            <button
              className={styles.presetButton}
              disabled={bleBeaconStore.loading}
              type='button'
              onClick={() => { void bleBeaconStore.fetch() }}
            >
              {bleBeaconStore.loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {bleBeaconStore.errorMessage ? (
            <div className={styles.error}>{bleBeaconStore.errorMessage}</div>
          ) : bleBeaconStore.loading && !bleBeaconStore.loaded ? (
            <div className={styles.status}>Loading…</div>
          ) : bleBeaconStore.beacons.length === 0 ? (
            <div className={styles.status}>No beacons</div>
          ) : (
            bleBeaconStore.beacons.map((b, i) => (
              <div
                key={i}
                style={i > 0
                  ? { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--vkui--color_separator_primary)' }
                  : { marginTop: 8 }}
              >
                <div style={{ fontWeight: 600 }}>{b.name || '(unnamed)'}</div>
                <div style={BEACON_META}>{b.address || 'auto MAC'}</div>
                <div style={BEACON_META}>{beaconSummary(b)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
})
