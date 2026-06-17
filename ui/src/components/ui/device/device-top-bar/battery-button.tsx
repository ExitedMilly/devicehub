import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Slider, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

export const BatteryButton = observer(() => {
  const batteryStore = useInjection(CONTAINER_IDS.deviceBatteryStore)
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
        title='Set battery'
        onClick={() => setIsOpen(open => !open)}
      >
        Battery
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
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
            <label className={styles.label} htmlFor='battery-charging'>На зарядке</label>
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
        </div>
      )}
    </div>
  )
})
