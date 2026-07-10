import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Slider, Switch } from '@vkontakte/vkui'
import { Icon28FlashOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

/**
 * "Battery" operblock block — level + charging state. Uses the per-device deviceBatteryStore.
 */
export const BatterySection = observer(() => {
  const batteryStore = useInjection(CONTAINER_IDS.deviceBatteryStore)

  return (
    <PanelSection active={batteryStore.charging} icon={<Icon28FlashOutline />} title='Battery'>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='battery-level'>Level: {batteryStore.level}%</label>
        <Slider
          id='battery-level'
          max={100}
          min={0}
          step={1}
          value={batteryStore.level}
          onChange={(value) => batteryStore.setLevel(Array.isArray(value) ? value[0] : value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor='battery-charging'>Charging</label>
        <Switch
          checked={batteryStore.charging}
          id='battery-charging'
          onChange={(event) => batteryStore.setCharging(event.target.checked)}
        />
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={!batteryStore.isValid || batteryStore.isApplying}
          type='button'
          onClick={() => { void batteryStore.apply() }}
        >
          {batteryStore.isApplying ? 'Applying...' : 'Apply'}
        </button>
      </div>

      {batteryStore.statusText && (
        <div className={batteryStore.errorMessage ? styles.error : styles.status}>
          {batteryStore.statusText}
        </div>
      )}
    </PanelSection>
  )
})
