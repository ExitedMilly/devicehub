import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './gps-button.module.css'

export const GpsButton = observer(() => {
  const gpsStore = useInjection(CONTAINER_IDS.deviceGpsStore)
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
        title='Set GPS'
        onClick={() => setIsOpen(open => !open)}
      >
        GPS
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='gps-latitude'>Latitude</label>
            <input
              className={styles.input}
              id='gps-latitude'
              placeholder='52.520008'
              type='text'
              value={gpsStore.latitude}
              onChange={(event) => gpsStore.setLatitude(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor='gps-longitude'>Longitude</label>
            <input
              className={styles.input}
              id='gps-longitude'
              placeholder='13.404954'
              type='text'
              value={gpsStore.longitude}
              onChange={(event) => gpsStore.setLongitude(event.target.value)}
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.applyButton}
              disabled={!gpsStore.isValid || gpsStore.isApplying || gpsStore.isStopping}
              type='button'
              onClick={() => { void gpsStore.apply() }}
            >
              {gpsStore.isApplying ? 'Applying...' : 'Set GPS'}
            </button>

            <button
              className={styles.stopButton}
              disabled={gpsStore.isApplying || gpsStore.isStopping}
              type='button'
              onClick={() => { void gpsStore.stop() }}
            >
              {gpsStore.isStopping ? 'Stopping...' : 'Stop GPS'}
            </button>

            <button
              className={styles.presetButton}
              type='button'
              onClick={() => {
                gpsStore.setLatitude('52.520008')
                gpsStore.setLongitude('13.404954')
              }}
            >
              Berlin
            </button>
          </div>

          {gpsStore.statusText && (
            <div className={gpsStore.errorMessage ? styles.error : styles.status}>
              {gpsStore.statusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})