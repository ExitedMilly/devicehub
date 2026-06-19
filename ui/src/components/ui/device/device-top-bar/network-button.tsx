import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, SegmentedControl, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

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
        </div>
      )}
    </div>
  )
})
