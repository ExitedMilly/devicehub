import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './pose-button.module.css'

export const PhonenumberButton = observer(() => {
  const phoneStore = useInjection(CONTAINER_IDS.devicePhonenumberStore)
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

  // Read the current number from the device when the popover opens.
  useEffect(() => {
    if (isOpen) void phoneStore.fetch()
  }, [isOpen, phoneStore])

  return (
    <div className={styles.wrapper} ref={ref}>
      <Button
        appearance='neutral'
        borderRadiusMode='inherit'
        className={topBarStyles.topButton}
        mode='tertiary'
        title='Set phone number'
        onClick={() => setIsOpen(open => !open)}
      >
        Number
      </Button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor='phone-number'>Phone number (digits only)</label>
            <input
              className={styles.input}
              id='phone-number'
              placeholder='79001234567'
              type='text'
              value={phoneStore.number}
              onChange={(event) => phoneStore.setNumber(event.target.value)}
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.applyButton}
              disabled={!phoneStore.isValid || phoneStore.isApplying}
              type='button'
              onClick={() => { void phoneStore.apply() }}
            >
              {phoneStore.isApplying ? 'Applying...' : 'Apply'}
            </button>
          </div>

          {phoneStore.statusText && (
            <div className={phoneStore.errorMessage ? styles.error : styles.status}>
              {phoneStore.statusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
