import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Panel, Tabs, TabsItem, View } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { NetworkSection } from './sections/network-section'
import { BluetoothSection } from './sections/bluetooth-section'
import { ProxySection } from './sections/proxy-section'
import { LocationSection } from './sections/location-section'
import { BatterySection } from './sections/battery-section'
import { PhoneSection } from './sections/phone-section'
import { TemperatureSection } from './sections/temperature-section'
import { RealisticSensorsSection } from './sections/realistic-sensors-section'
import { LightSection } from './sections/light-section'
import { PoseSection } from './sections/pose-section'
import { ScenariosSection } from './sections/scenarios-section'
import { BackupSection } from './sections/backup-section'
import { DeviceButtonsSection } from './sections/device-buttons-section'
import { ConstructorTab } from './constructor-tab'

import styles from './device-control-panel.module.css'

type Tab = 'controls' | 'constructor'

/**
 * Right-hand device control panel. Two tabs: "Controls" (one collapsible block per
 * operblock, migrated from the top bar) and "Constructor" (placeholder for later). The
 * blocks are a single vertical column on the full panel width; each is an independent
 * uncontrolled Accordion, so all start collapsed and any number can be open at once
 * (multi-open). The whole panel scrolls vertically as one.
 *
 * dispose(): this panel owns the teardown of the per-device stores it depends on,
 * because it is mounted for the whole device session — so exactly one dispose fires on
 * device change / unmount. It disposes DeviceScenariosStore (every ambient timer/reaction),
 * DeviceConstructorStore (cross-tab storage listener), and DeviceGpsStore (the walk-polling
 * interval). The blocks that inject these stores never dispose them; the panel is the sole owner.
 */
export const DeviceControlPanel = observer(() => {
  const [tab, setTab] = useState<Tab>('controls')

  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)
  const constructorStore = useInjection(CONTAINER_IDS.deviceConstructorStore)
  const gps = useInjection(CONTAINER_IDS.deviceGpsStore)
  useEffect(() => () => {
    scenarios.dispose()
    constructorStore.dispose() // removes its cross-tab `storage` listener
    gps.dispose() // clears the walk-polling interval
  }, [scenarios, constructorStore, gps])

  return (
    <View activePanel='control'>
      <Panel className={styles.deviceControlPanel} id='control'>
        <Tabs>
          <TabsItem selected={tab === 'controls'} onClick={() => setTab('controls')}>
            Controls
          </TabsItem>
          <TabsItem selected={tab === 'constructor'} onClick={() => setTab('constructor')}>
            Constructor
          </TabsItem>
        </Tabs>

        {tab === 'controls' ? (
          <div className={styles.stack}>
            <NetworkSection />
            <BluetoothSection />
            <ProxySection />
            <LocationSection />
            <BatterySection />
            <PhoneSection />
            <TemperatureSection />
            <RealisticSensorsSection />
            <LightSection />
            <PoseSection />
            <ScenariosSection />
            <BackupSection />
            <DeviceButtonsSection />
          </div>
        ) : (
          <ConstructorTab />
        )}
      </Panel>
    </View>
  )
})
