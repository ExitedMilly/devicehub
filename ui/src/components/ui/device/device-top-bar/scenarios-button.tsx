import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { ScenarioPreset } from '@/store/device-scenarios-store'

const PRESETS: Array<{ value: ScenarioPreset; label: string }> = [
  { value: 'onCharge', label: 'On charge' },
  { value: 'metro', label: 'Metro' },
  { value: 'reset', label: 'Reset' },
]

export const ScenariosButton = observer(() => {
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)
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

  // Stop every ambient timer when leaving the device (unmount / device change).
  useEffect(() => {
    return () => { scenarios.dispose() }
  }, [scenarios])

  return (
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        title='Scenarios'
        onClick={() => setIsOpen(open => !open)}
      >
        Scenarios
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>

          {/* ============== Presets (one-shot) ============== */}

          <div className={styles.sectionTitle}>Presets</div>

          <div className={styles.presets}>
            {PRESETS.map((p) => (
              <button
                key={p.value}
                className={styles.presetButton}
                disabled={scenarios.busyPreset !== null}
                type='button'
                onClick={() => scenarios.applyPreset(p.value)}
              >
                {scenarios.busyPreset === p.value ? 'Applying…' : p.label}
              </button>
            ))}
          </div>

          {scenarios.statusText && (
            <div className={scenarios.errorMessage ? styles.error : styles.status}>
              {scenarios.statusText}
            </div>
          )}

          <hr className={styles.divider} />

          {/* ============== Ambient (timer-driven) ============== */}

          <div className={styles.sectionTitle}>Ambient</div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='scn-cycle'>
              Day / Night cycle{scenarios.cycleOn ? ' · running' : ''}
            </label>
            <Switch
              checked={scenarios.cycleOn}
              id='scn-cycle'
              onChange={(e) => scenarios.setCycleOn(e.target.checked)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='scn-cycle-period'>Cycle period (s)</label>
            <input
              className={styles.input}
              id='scn-cycle-period'
              min={4}
              type='number'
              value={scenarios.cyclePeriodSec}
              onChange={(e) => scenarios.setCyclePeriodSec(Number(e.target.value))}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='scn-rotate'>
              Periodic rotation{scenarios.rotateOn ? ' · running' : ''}
            </label>
            <Switch
              checked={scenarios.rotateOn}
              id='scn-rotate'
              onChange={(e) => scenarios.setRotateOn(e.target.checked)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='scn-rotate-interval'>Rotation interval (s)</label>
            <input
              className={styles.input}
              id='scn-rotate-interval'
              min={2}
              type='number'
              value={scenarios.rotateIntervalSec}
              onChange={(e) => scenarios.setRotateIntervalSec(Number(e.target.value))}
            />
          </div>
        </div>
      )}
    </div>
  )
})
