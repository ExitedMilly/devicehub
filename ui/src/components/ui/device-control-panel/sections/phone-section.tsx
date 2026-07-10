import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Icon28PhoneOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

/**
 * "Phone number" operblock block — sets the device's own line number. Uses the
 * per-device devicePhonenumberStore.
 */
export const PhoneSection = observer(() => {
  const phoneStore = useInjection(CONTAINER_IDS.devicePhonenumberStore)

  // Read the current number from the device when the panel mounts.
  useEffect(() => {
    void phoneStore.fetch()
  }, [phoneStore])

  return (
    <PanelSection icon={<Icon28PhoneOutline />} title='Phone number'>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='phone-number'>Phone number (digits only)</label>
        <input
          className={styles.input}
          id='phone-number'
          placeholder='79001234567'
          type='text'
          value={phoneStore.number}
          onChange={(event) => phoneStore.setNumber(event.target.value)}
        />
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={!phoneStore.isValid || phoneStore.isApplying}
          type='button'
          onClick={() => { void phoneStore.apply() }}
        >
          {phoneStore.isApplying ? 'Applying...' : 'Apply'}
        </button>
      </div>

      {phoneStore.statusText && (
        <div className={phoneStore.errorMessage ? styles.error : styles.status}>
          {phoneStore.statusText}
        </div>
      )}
    </PanelSection>
  )
})
