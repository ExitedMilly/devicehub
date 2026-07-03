import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, SegmentedControl, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { CSSProperties } from 'react'
import type { FakeSecurity } from '@/store/device-network-store'

const FAKE_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}
const FAKE_ROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' }
const FAKE_SUBROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }
const FAKE_MAC_LABEL: CSSProperties = {
  display: 'flex',
  gap: 4,
  alignItems: 'center',
  flex: '0 0 auto',
  fontSize: 12,
  color: 'var(--vkui--color_text_secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const NETWORK_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gprs', label: 'GPRS' },
  { value: 'edge', label: 'EDGE' },
  { value: 'umts', label: 'UMTS' },
  { value: 'hsdpa', label: 'HSDPA' },
  { value: 'lte', label: 'LTE' },
]

const REGISTRATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'home', label: 'Home' },
  { value: 'roaming', label: 'Roaming' },
  { value: 'searching', label: 'Searching' },
  { value: 'unregistered', label: 'Unregistered' },
]

export const NetworkButton = observer(() => {
  const networkStore = useInjection(CONTAINER_IDS.deviceNetworkStore)
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

  // Sync fake-scan on/off state when the popover opens.
  useEffect(() => {
    if (isOpen) void networkStore.fetchFakeScanState()
  }, [isOpen, networkStore])

  return (
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        title='Set network'
        onClick={() => setIsOpen(open => !open)}
      >
        Network
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.field}>
            <label className={styles.label}>Signal</label>
            <SegmentedControl
              options={[
                { label: 'Weak', value: 'weak' },
                { label: 'Strong', value: 'strong' },
              ]}
              value={networkStore.signalStrong ? 'strong' : 'weak'}
              onChange={(value) => networkStore.setSignalStrong(value === 'strong')}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='network-type'>Network speed</label>
            <select
              className={styles.input}
              id='network-type'
              value={networkStore.networkType}
              onChange={(e) => networkStore.setNetworkType(e.target.value)}
            >
              {NETWORK_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='network-registration'>Registration</label>
            <select
              className={styles.input}
              id='network-registration'
              value={networkStore.registration}
              onChange={(e) => networkStore.setRegistration(e.target.value)}
            >
              {REGISTRATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='network-wifi'>Wi-Fi</label>
            <Switch
              checked={networkStore.wifi}
              id='network-wifi'
              onChange={(event) => networkStore.setWifi(event.target.checked)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='network-airplane'>Airplane mode</label>
            <Switch
              checked={networkStore.airplane}
              id='network-airplane'
              onChange={(event) => networkStore.setAirplane(event.target.checked)}
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.applyButton}
              disabled={networkStore.isApplying}
              type='button'
              onClick={() => { void networkStore.apply() }}
            >
              {networkStore.isApplying ? 'Applying...' : 'Apply'}
            </button>
          </div>

          {networkStore.statusText && (
            <div className={networkStore.errorMessage ? styles.error : styles.status}>
              {networkStore.statusText}
            </div>
          )}

          {/* ============== Fake Wi-Fi networks section ============== */}

          <hr className={styles.divider} />

          <div
            className={styles.sectionTitle}
            style={networkStore.fakingActive ? { color: 'var(--vkui--color_text_positive)' } : undefined}
          >
            Fake Wi-Fi networks{networkStore.fakingActive ? ' · faking' : ''}
          </div>

          {networkStore.fakeNetworks.map((n, i) => (
            <div
              key={i}
              style={i > 0
                ? { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--vkui--color_separator_primary)' }
                : { marginTop: 8 }}
            >
              <div style={FAKE_ROW}>
                <input
                  className={styles.input}
                  placeholder='SSID'
                  style={{ flex: 2, minWidth: 0 }}
                  type='text'
                  value={n.ssid}
                  onChange={(e) => networkStore.updateFakeNetwork(i, { ssid: e.target.value })}
                />
                <select
                  className={styles.input}
                  style={{ flex: 1, minWidth: 0 }}
                  value={n.security}
                  onChange={(e) => networkStore.updateFakeNetwork(i, { security: e.target.value as FakeSecurity })}
                >
                  <option value='open'>Open</option>
                  <option value='wpa2'>WPA2</option>
                  <option value='wpa3'>WPA3</option>
                </select>
                <input
                  className={styles.input}
                  placeholder='dBm'
                  style={{ width: 68, flex: '0 0 auto' }}
                  type='number'
                  value={n.signalDbm}
                  onChange={(e) => networkStore.updateFakeNetwork(i, { signalDbm: e.target.value })}
                />
                <button
                  className={styles.stopButton}
                  style={{ flex: '0 0 auto', minWidth: 0, padding: '10px 12px' }}
                  title='Remove'
                  type='button'
                  onClick={() => networkStore.removeFakeNetwork(i)}
                >
                  ×
                </button>
              </div>
              <div style={FAKE_SUBROW}>
                <label style={FAKE_MAC_LABEL}>
                  <input
                    checked={n.bssidAuto}
                    type='checkbox'
                    onChange={(e) => networkStore.updateFakeNetwork(i, { bssidAuto: e.target.checked })}
                  />
                  Auto MAC
                </label>
                <input
                  className={styles.input}
                  disabled={n.bssidAuto}
                  placeholder={n.bssidAuto ? 'auto-generated' : '02:00:00:00:00:01'}
                  style={{ flex: 1, minWidth: 0, opacity: n.bssidAuto ? 0.5 : 1 }}
                  type='text'
                  value={n.bssidAuto ? '' : n.bssid}
                  onChange={(e) => networkStore.updateFakeNetwork(i, { bssid: e.target.value })}
                />
              </div>
            </div>
          ))}

          <div className={styles.actions}>
            <button
              className={styles.presetButton}
              type='button'
              onClick={() => networkStore.addFakeNetwork()}
            >
              Add network
            </button>
            <button
              className={styles.applyButton}
              disabled={!networkStore.isFakeValid || networkStore.fakeIsApplying}
              style={networkStore.fakingActive ? FAKE_ACTIVE : undefined}
              type='button'
              onClick={() => { void networkStore.applyFakeScan() }}
            >
              {networkStore.fakeIsApplying ? 'Applying...' : 'Apply'}
            </button>
            <button
              className={styles.stopButton}
              disabled={networkStore.fakeIsApplying}
              type='button'
              onClick={() => { void networkStore.stopFakeScan() }}
            >
              Stop
            </button>
          </div>

          {networkStore.fakeStatusText && (
            <div className={networkStore.fakeErrorMessage ? styles.error : styles.status}>
              {networkStore.fakeStatusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
