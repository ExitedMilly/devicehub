import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Icon28SortHorizontalOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

/**
 * "Proxy" operblock block — routes device HTTP traffic through a host:port (e.g. for
 * interception). Uses the per-device deviceProxyStore.
 */
export const ProxySection = observer(() => {
  const proxyStore = useInjection(CONTAINER_IDS.deviceProxyStore)

  // Sync the proxy on/off state + auto-detected host address (proxy button did this on open).
  useEffect(() => {
    void proxyStore.fetchStatus()
    void proxyStore.fetchHostAddress()
  }, [proxyStore])

  return (
    <PanelSection active={proxyStore.enabled} icon={<Icon28SortHorizontalOutline />} title='Proxy'>
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
    </PanelSection>
  )
})
