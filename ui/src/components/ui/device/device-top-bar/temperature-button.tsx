import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { CSSProperties } from 'react'

// Green "active" look on the trigger while the temperature operblock is on
// (matches the Bluetooth / active-scenario trigger styling).
const TRIGGER_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}

// Standalone top-bar control for the ambient-temperature operblock. Its state and
// ALL coordination (the scenario resource model + the sensor-noise "owned" set that
// makes noise yield the temperature sensor) live in the shared DeviceScenariosStore
// singleton — this component only renders the control, so moving it out of the
// Scenarios popup into its own button does not touch that coordination.
export const TemperatureButton = observer(() => {
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
        style={scenarios.temperatureOn ? TRIGGER_ACTIVE : undefined}
        title='Temperature'
        onClick={() => setIsOpen(open => !open)}
      >
        Temperature
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
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
        </div>
      )}
    </div>
  )
})
