import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

import type { PoseScenarioName } from '@/store/device-pose-store'

const SCENARIO_OPTIONS: Array<{ value: PoseScenarioName; label: string }> = [
  { value: 'walking', label: 'Walking (in pocket)' },
  { value: 'cycling', label: 'Cycling (jacket pocket)' },
  { value: 'driving', label: 'Driving (dashboard mount)' },
]

export const PoseButton = observer(() => {
  const poseStore = useInjection(CONTAINER_IDS.devicePoseStore)
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
        title='Set pose'
        onClick={() => setIsOpen(open => !open)}
      >
        Pose
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>

          {/* ============== Single-shot pose section ============== */}

          <div className={styles.field}>
            <label className={styles.label} htmlFor='pose-pitch'>Pitch</label>
            <input
              className={styles.input}
              id='pose-pitch'
              placeholder='0'
              type='text'
              value={poseStore.pitch}
              onChange={(event) => poseStore.setPitch(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='pose-yaw'>Yaw</label>
            <input
              className={styles.input}
              id='pose-yaw'
              placeholder='0'
              type='text'
              value={poseStore.yaw}
              onChange={(event) => poseStore.setYaw(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='pose-roll'>Roll</label>
            <input
              className={styles.input}
              id='pose-roll'
              placeholder='0'
              type='text'
              value={poseStore.roll}
              onChange={(event) => poseStore.setRoll(event.target.value)}
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.applyButton}
              disabled={!poseStore.isValid || poseStore.isApplying}
              type='button'
              onClick={() => { void poseStore.apply() }}
            >
              {poseStore.isApplying ? 'Applying...' : 'Apply'}
            </button>
          </div>

          <div className={styles.presets}>
            <button type='button' className={styles.presetButton} onClick={() => poseStore.applyPreset(0, 0, 0)}>
              Flat
            </button>
            <button type='button' className={styles.presetButton} onClick={() => poseStore.applyPreset(0, 0, 90)}>
              Right tilt
            </button>
            <button type='button' className={styles.presetButton} onClick={() => poseStore.applyPreset(0, 0, -90)}>
              Left tilt
            </button>
            <button type='button' className={styles.presetButton} onClick={() => poseStore.applyPreset(90, 0, 0)}>
              Top down
            </button>
            <button type='button' className={styles.presetButton} onClick={() => poseStore.applyPreset(-90, 0, 0)}>
              Bottom up
            </button>
          </div>

          {poseStore.statusText && (
            <div className={poseStore.errorMessage ? styles.error : styles.status}>
              {poseStore.statusText}
            </div>
          )}

          <hr className={styles.divider} />

          {/* ============== Scenario section ============== */}

          <div className={styles.sectionTitle}>Motion scenario</div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='pose-scenario'>Scenario</label>
            <select
              className={styles.input}
              id='pose-scenario'
              value={poseStore.scenarioName}
              onChange={(e) => poseStore.setScenarioName(e.target.value as PoseScenarioName)}
              disabled={poseStore.isScenarioActive}
            >
              {SCENARIO_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.actions}>
            {!poseStore.isScenarioActive && (
              <button
                className={styles.applyButton}
                disabled={poseStore.scenarioIsStarting}
                type='button'
                onClick={() => { void poseStore.startScenario() }}
              >
                {poseStore.scenarioIsStarting ? 'Starting...' : 'Start scenario'}
              </button>
            )}

            {poseStore.scenarioBackend?.status === 'running' && (
              <button
                className={styles.presetButton}
                disabled={poseStore.scenarioIsControlling}
                type='button'
                onClick={() => { void poseStore.pauseScenario() }}
              >
                Pause
              </button>
            )}

            {poseStore.scenarioBackend?.status === 'paused' && (
              <button
                className={styles.applyButton}
                disabled={poseStore.scenarioIsControlling}
                type='button'
                onClick={() => { void poseStore.resumeScenario() }}
              >
                Resume
              </button>
            )}

            {poseStore.isScenarioActive && (
              <button
                className={styles.stopButton}
                disabled={poseStore.scenarioIsControlling}
                type='button'
                onClick={() => { void poseStore.stopScenario() }}
              >
                Stop
              </button>
            )}
          </div>

          {poseStore.scenarioStatusText && (
            <div className={poseStore.scenarioErrorMessage ? styles.error : styles.status}>
              {poseStore.scenarioStatusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
