import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Switch } from '@vkontakte/vkui'
import { Icon24ThermometerOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

/**
 * "Temperature" operblock block — ambient temperature on/off + value, applied to the
 * device on demand. Backed by the shared per-device deviceScenariosStore (the same
 * singleton the panel owns for dispose()); logic unchanged, only relocated.
 */
export const TemperatureSection = observer(() => {
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)

  // Raw edit string decoupled from the clamped store value, so a leading '-'
  // (negative temps are in range) survives typing. Blur commits the value to the
  // store; the device is written only on the explicit Apply (or Enter).
  const [tempInput, setTempInput] = useState(String(scenarios.temperatureC))
  useEffect(() => {
    setTempInput(String(scenarios.temperatureC))
  }, [scenarios.temperatureC])

  // Commit the raw edit string to the store VALUE (clamped) — used on blur so
  // negatives type cleanly. Does NOT push to the device; applying is explicit (Apply).
  const commitValue = (raw: string): void => {
    const value = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(value)) {
      scenarios.setTemperatureValue(value)
    }
    // Always re-sync to the committed (clamped) value — covers empty/invalid edits
    // and the clamp-equals-current case (a MobX no-op that wouldn't fire the effect).
    setTempInput(String(scenarios.temperatureC))
  }

  // Explicit apply (Apply button / Enter): commit the current edit first (so the
  // latest typed value is used even without a blur), then push it to the device.
  const applyNow = (raw: string): void => {
    commitValue(raw)
    void scenarios.applyTemperatureNow()
  }

  return (
    <PanelSection active={scenarios.temperatureOn} icon={<Icon24ThermometerOutline />} title='Temperature'>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='temp-toggle'>Temperature</label>
        <Switch
          checked={scenarios.temperatureOn}
          id='temp-toggle'
          onChange={(e) => scenarios.toggleTemperature(e.target.checked)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='temp-value'>Temperature, °C</label>
        <input
          className={styles.input}
          id='temp-value'
          max={45}
          min={-20}
          type='number'
          value={tempInput}
          onBlur={(e) => commitValue(e.target.value)}
          onChange={(e) => setTempInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyNow(e.currentTarget.value) }}
        />
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={!scenarios.temperatureOn || scenarios.temperatureApplying}
          title={scenarios.temperatureOn ? 'Apply this temperature to the device' : 'Turn Temperature on first'}
          type='button'
          onClick={() => applyNow(tempInput)}
        >
          {scenarios.temperatureApplying ? 'Applying…' : 'Apply'}
        </button>
      </div>

      {(scenarios.temperatureError || scenarios.temperatureStatus) && (
        <div className={scenarios.temperatureError ? styles.error : styles.status}>
          {scenarios.temperatureError ?? scenarios.temperatureStatus}
        </div>
      )}
    </PanelSection>
  )
})
