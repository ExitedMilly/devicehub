import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import {
  Button,
  Footnote,
  FormItem,
  FormLayoutGroup,
  Header,
  Input,
  NativeSelect,
  SelectionControl,
  Switch,
} from '@vkontakte/vkui'
import { Icon28LocationOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'

import styles from './location-section.module.css'

import type { WalkSpeedPreset, WalkProfile } from '@/store/device-gps-store'

const SPEED_OPTIONS: Array<{ value: WalkSpeedPreset; label: string }> = [
  { value: 'walking', label: 'Walking (5 km/h)' },
  { value: 'jogging', label: 'Jogging (9 km/h)' },
  { value: 'running', label: 'Running (14 km/h)' },
  { value: 'cycling', label: 'Cycling (20 km/h)' },
  { value: 'driving', label: 'Driving (50 km/h)' },
]

const PROFILE_OPTIONS: Array<{ value: WalkProfile; label: string }> = [
  { value: 'foot', label: 'Foot' },
  { value: 'bike', label: 'Bike' },
  { value: 'driving', label: 'Car' },
]

const StatusLine = ({ text, error }: { text: string | null; error?: boolean }) =>
  text ? <Footnote className={error ? styles.error : styles.status}>{text}</Footnote> : null

/**
 * "Location" operblock block of the device control panel — GPS point set/stop,
 * walk-route simulation, and the location-derived Weather + BSSID-sync toggles. Moved
 * here from the top-bar GPS button; uses the same per-device singleton stores
 * (deviceGpsStore + deviceScenariosStore), so all coordination is unchanged.
 */
export const LocationSection = observer(() => {
  const gps = useInjection(CONTAINER_IDS.deviceGpsStore)
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)

  const active =
    gps.appliedLatitude != null || gps.isWalkActive || scenarios.weatherOn || scenarios.bssidSyncOn

  return (
    <PanelSection active={active} icon={<Icon28LocationOutline />} title='Location'>
      {/* ---------------- Set location ---------------- */}
      <Header size='s'>Set location</Header>
      <FormLayoutGroup mode='horizontal'>
        <FormItem top='Latitude'>
          <Input
            placeholder='55.751244'
            value={gps.latitude}
            onChange={(e) => gps.setLatitude(e.target.value)}
          />
        </FormItem>
        <FormItem top='Longitude'>
          <Input
            placeholder='37.618423'
            value={gps.longitude}
            onChange={(e) => gps.setLongitude(e.target.value)}
          />
        </FormItem>
      </FormLayoutGroup>

      <div className={styles.buttons}>
        <Button
          loading={gps.isApplying}
          size='s'
          stretched
          disabled={!gps.isValid || gps.isApplying || gps.isStopping}
          onClick={() => { void gps.apply() }}
        >
          Set GPS
        </Button>
        <Button
          appearance='negative'
          mode='secondary'
          size='s'
          stretched
          disabled={gps.isApplying || gps.isStopping}
          loading={gps.isStopping}
          onClick={() => { void gps.stop() }}
        >
          Stop
        </Button>
        <Button
          mode='tertiary'
          size='s'
          onClick={() => {
            gps.setLatitude('55.751244')
            gps.setLongitude('37.618423')
          }}
        >
          Moscow
        </Button>
      </div>
      <StatusLine error={!!gps.errorMessage} text={gps.statusText} />

      {/* ---------------- Weather & Wi-Fi (location-derived) ---------------- */}
      <Header size='s'>Weather &amp; Wi-Fi</Header>
      <SelectionControl className={styles.toggle}>
        <Switch checked={scenarios.weatherOn} onChange={(e) => scenarios.toggleWeather(e.target.checked)} />
        <SelectionControl.Label>Weather from location</SelectionControl.Label>
      </SelectionControl>
      <StatusLine
        error={!!scenarios.weatherError}
        text={scenarios.weatherApplying ? 'Fetching weather…' : (scenarios.weatherError ?? scenarios.weatherStatus)}
      />

      <SelectionControl
        className={styles.toggle}
        title="App-level only: fills getScanResults() with the location's real BSSIDs for apps that read the Wi-Fi scan (e.g. antifraud). Does NOT change system/fused geolocation."
      >
        <Switch checked={scenarios.bssidSyncOn} onChange={(e) => scenarios.toggleBssidSync(e.target.checked)} />
        <SelectionControl.Label>Sync Wi-Fi with location (BSSID)</SelectionControl.Label>
      </SelectionControl>
      <StatusLine
        error={!!scenarios.bssidError}
        text={scenarios.bssidApplying ? 'Looking up Wi-Fi…' : (scenarios.bssidError ?? scenarios.bssidStatus)}
      />
      {scenarios.bssidSyncOn && (
        <Footnote className={styles.note}>
          App-level only — apps reading the Wi-Fi scan; not system/fused location.
        </Footnote>
      )}

      {/* ---------------- Walk simulation ---------------- */}
      <Header size='s'>Walk simulation</Header>
      <FormLayoutGroup mode='horizontal'>
        <FormItem top='From lat'>
          <Input placeholder='52.520008' value={gps.walkFromLat} onChange={(e) => gps.setWalkFromLat(e.target.value)} />
        </FormItem>
        <FormItem top='From lon'>
          <Input placeholder='13.404954' value={gps.walkFromLon} onChange={(e) => gps.setWalkFromLon(e.target.value)} />
        </FormItem>
      </FormLayoutGroup>
      <FormLayoutGroup mode='horizontal'>
        <FormItem top='To lat'>
          <Input placeholder='52.516275' value={gps.walkToLat} onChange={(e) => gps.setWalkToLat(e.target.value)} />
        </FormItem>
        <FormItem top='To lon'>
          <Input placeholder='13.377704' value={gps.walkToLon} onChange={(e) => gps.setWalkToLon(e.target.value)} />
        </FormItem>
      </FormLayoutGroup>
      <FormLayoutGroup mode='horizontal'>
        <FormItem top='Speed'>
          <NativeSelect value={gps.walkSpeed} onChange={(e) => gps.setWalkSpeed(e.target.value as WalkSpeedPreset)}>
            {SPEED_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect>
        </FormItem>
        <FormItem top='Routing'>
          <NativeSelect value={gps.walkProfile} onChange={(e) => gps.setWalkProfile(e.target.value as WalkProfile)}>
            {PROFILE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect>
        </FormItem>
      </FormLayoutGroup>

      <div className={styles.buttons}>
        {!gps.isWalkActive && (
          <Button
            loading={gps.walkIsStarting}
            size='s'
            stretched
            disabled={!gps.isWalkInputValid || gps.walkIsStarting}
            onClick={() => { void gps.startWalk() }}
          >
            Start walk
          </Button>
        )}
        {gps.walkBackend?.status === 'running' && (
          <Button mode='secondary' size='s' stretched disabled={gps.walkIsControlling} onClick={() => { void gps.pauseWalk() }}>
            Pause
          </Button>
        )}
        {gps.walkBackend?.status === 'paused' && (
          <Button size='s' stretched disabled={gps.walkIsControlling} onClick={() => { void gps.resumeWalk() }}>
            Resume
          </Button>
        )}
        {gps.isWalkActive && (
          <Button appearance='negative' mode='secondary' size='s' stretched disabled={gps.walkIsControlling} onClick={() => { void gps.stopWalk() }}>
            Stop walk
          </Button>
        )}
        <Button
          mode='tertiary'
          size='s'
          title='Brandenburger Tor → Potsdamer Platz'
          onClick={() => {
            gps.setWalkFromLat('52.516275')
            gps.setWalkFromLon('13.377704')
            gps.setWalkToLat('52.509663')
            gps.setWalkToLon('13.376217')
          }}
        >
          Berlin demo
        </Button>
      </div>

      <SelectionControl className={styles.toggle}>
        <Switch
          checked={gps.walkPauseAccelOnPause}
          onChange={(e) => gps.setWalkPauseAccelOnPause(e.target.checked)}
        />
        <SelectionControl.Label>Pause accelerometer when walk is paused</SelectionControl.Label>
      </SelectionControl>
      <StatusLine error={!!gps.walkErrorMessage} text={gps.walkStatusText} />
    </PanelSection>
  )
})
