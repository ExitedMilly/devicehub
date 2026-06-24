import { Panel, View } from '@vkontakte/vkui'

import { DeviceButtonsControl } from './tabs/dashboard-tab/device-buttons-control'

import styles from './device-control-panel.module.css'

export const DeviceControlPanel = () => {
  return (
    <View activePanel='control'>
      <Panel className={styles.deviceControlPanel} id='control'>
        <DeviceButtonsControl />
      </Panel>
    </View>
  )
}
