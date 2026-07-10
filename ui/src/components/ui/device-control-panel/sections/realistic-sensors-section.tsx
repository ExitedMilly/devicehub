import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Switch } from '@vkontakte/vkui'
import { Icon28RadiowavesAroundOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'
import styles from './controls.module.css'

/**
 * "Realistic sensors" operblock block — a single toggle that adds lifelike noise/jitter
 * to the accelerometer / gyroscope / magnetometer readings. Backed by the shared
 * per-device deviceScenariosStore (sensor-noise); logic unchanged, only relocated.
 */
export const RealisticSensorsSection = observer(() => {
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)

  return (
    <PanelSection
      active={scenarios.sensorNoiseOn}
      icon={<Icon28RadiowavesAroundOutline />}
      title='Realistic sensors'
    >
      <div className={styles.hint}>
        Adds realistic noise to the accelerometer, gyroscope and magnetometer so
        readings look like a real device in hand rather than a static emulator.
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-noise'>Sensor noise</label>
        <Switch
          checked={scenarios.sensorNoiseOn}
          id='scn-noise'
          onChange={(e) => scenarios.toggleSensorNoise(e.target.checked)}
        />
      </div>
    </PanelSection>
  )
})
