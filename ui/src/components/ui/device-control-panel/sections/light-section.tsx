import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Icon28LightbulbOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

const PRESETS: Array<{ label: string; lux: number }> = [
  { label: 'Dark', lux: 0 },
  { label: 'Dim', lux: 10 },
  { label: 'Room', lux: 50 },
  { label: 'Office', lux: 300 },
  { label: 'Bright', lux: 1000 },
  { label: 'Outdoor', lux: 10000 },
]

/**
 * "Light" operblock block — ambient light sensor illuminance (lux) + quick presets.
 * Uses the per-device deviceLightStore.
 */
export const LightSection = observer(() => {
  const lightStore = useInjection(CONTAINER_IDS.deviceLightStore)

  return (
    <PanelSection icon={<Icon28LightbulbOutline />} title='Light'>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='light-lux'>Lux</label>
        <input
          className={styles.input}
          id='light-lux'
          placeholder='500'
          type='text'
          value={lightStore.lux}
          onChange={(event) => lightStore.setLux(event.target.value)}
        />
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={!lightStore.isValid || lightStore.isApplying}
          type='button'
          onClick={() => { void lightStore.apply() }}
        >
          {lightStore.isApplying ? 'Applying...' : 'Apply'}
        </button>
      </div>

      <div className={styles.presets}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type='button'
            className={styles.presetButton}
            onClick={() => lightStore.applyPreset(preset.lux)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {lightStore.statusText && (
        <div className={lightStore.errorMessage ? styles.error : styles.status}>
          {lightStore.statusText}
        </div>
      )}
    </PanelSection>
  )
})
