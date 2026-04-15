import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

const PRESETS: Array<{ label: string; lux: number }> = [
  { label: 'Dark', lux: 0 },
  { label: 'Dim', lux: 10 },
  { label: 'Room', lux: 50 },
  { label: 'Office', lux: 300 },
  { label: 'Bright', lux: 1000 },
  { label: 'Outdoor', lux: 10000 },
]

export const LightButton = observer(() => {
  const lightStore = useInjection(CONTAINER_IDS.deviceLightStore)
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
        title='Set ambient light'
        onClick={() => setIsOpen(open => !open)}
      >
        Light
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
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
        </div>
      )}
    </div>
  )
})
