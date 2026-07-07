import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { CSSProperties } from 'react'

// Green "active" look on the trigger when the proxy is on (like active scenarios).
const TRIGGER_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}

export const ProxyButton = observer(() => {
  const proxyStore = useInjection(CONTAINER_IDS.deviceProxyStore)
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

  // Sync the current on/off state + the auto-detected host address on open.
  useEffect(() => {
    if (isOpen) {
      void proxyStore.fetchStatus()
      void proxyStore.fetchHostAddress()
    }
  }, [isOpen, proxyStore])

  return (
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        style={proxyStore.enabled ? TRIGGER_ACTIVE : undefined}
        title='HTTP proxy'
        onClick={() => setIsOpen(open => !open)}
      >
        Proxy
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='proxy-host'>Host</label>
            <input
              className={styles.input}
              id='proxy-host'
              placeholder={proxyStore.hostAddress || '172.20.0.1'}
              type='text'
              value={proxyStore.host}
              onChange={(event) => proxyStore.setHost(event.target.value)}
            />
          </div>

          {proxyStore.hostAddress && (
            <div className={styles.status} style={{ marginTop: -4 }}>
              Host machine (for interception): {proxyStore.hostAddress}{' '}
              <button
                type='button'
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--vkui--color_text_link)', cursor: 'pointer', font: 'inherit' }}
                onClick={() => proxyStore.useHostAddress()}
              >
                use
              </button>
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor='proxy-port'>Port</label>
            <input
              className={styles.input}
              id='proxy-port'
              max={65535}
              min={1}
              placeholder='8080'
              type='number'
              value={proxyStore.port}
              onChange={(event) => proxyStore.setPort(event.target.value)}
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.applyButton}
              disabled={!proxyStore.isValid || proxyStore.isApplying}
              type='button'
              onClick={() => { void proxyStore.apply() }}
            >
              {proxyStore.isApplying ? 'Applying...' : 'Apply'}
            </button>
            <button
              className={styles.stopButton}
              disabled={proxyStore.isApplying}
              type='button'
              onClick={() => { void proxyStore.disable() }}
            >
              Disable
            </button>
          </div>

          {proxyStore.statusText && (
            <div className={proxyStore.errorMessage ? styles.error : styles.status}>
              {proxyStore.statusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
