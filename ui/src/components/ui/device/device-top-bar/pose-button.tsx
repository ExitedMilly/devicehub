import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

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
        </div>
      )}
    </div>
  )
})
