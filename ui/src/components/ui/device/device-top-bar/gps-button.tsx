import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button, Checkbox } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import topBarStyles from './device-top-bar.module.css'
import styles from './gps-button.module.css'

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

export const GpsButton = observer(() => {
  const gpsStore = useInjection(CONTAINER_IDS.deviceGpsStore)
  // Shared scenarios store owns the "Weather from location" feature (it reads the
  // applied GPS location and owns the temperature/humidity/pressure resources).
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)
  const [isOpen, setIsOpen] = useState(false)
  const [showWalkSettings, setShowWalkSettings] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Extensible list of walk automation toggles. Add more rows here (e.g. a
  // light-sensor sync) and the settings panel renders them automatically.
  const walkSettings: Array<{ key: string; label: string; value: boolean; setter: (v: boolean) => void }> = [
    {
      key: 'pauseAccelOnPause',
      label: 'Pause accelerometer when walk is paused',
      value: gpsStore.walkPauseAccelOnPause,
      setter: (v) => gpsStore.setWalkPauseAccelOnPause(v),
    },
  ]

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

          {/* ============== Point GPS section ============== */}

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

          <hr className={styles.divider} />

          {/* ============== Walk simulation section ============== */}

          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>Walk simulation</div>
            <button
              className={styles.iconButton}
              type='button'
              title='Walk settings'
              aria-label='Walk settings'
              aria-expanded={showWalkSettings}
              onClick={() => setShowWalkSettings((s) => !s)}
            >
              ⚙
            </button>
          </div>

          {showWalkSettings && (
            <div className={styles.settingsPanel}>
              {walkSettings.map((s) => (
                <div key={s.key} className={styles.settingRow}>
                  <Checkbox
                    checked={s.value}
                    onChange={(e) => s.setter(e.target.checked)}
                  >
                    {s.label}
                  </Checkbox>
                </div>
              ))}

              {/* Real weather (Open-Meteo) → temp/humidity/pressure. Follows the live
                  location: a fixed point, or the walk position while walking. */}
              <div className={styles.settingRow}>
                <Checkbox
                  checked={scenarios.weatherOn}
                  onChange={(e) => scenarios.toggleWeather(e.target.checked)}
                >
                  Weather from location
                </Checkbox>
              </div>
              {(scenarios.weatherApplying || scenarios.weatherError || scenarios.weatherStatus) && (
                <div className={scenarios.weatherError ? styles.error : styles.status}>
                  {scenarios.weatherApplying
                    ? 'Fetching weather…'
                    : (scenarios.weatherError ?? scenarios.weatherStatus)}
                </div>
              )}

              {/* Real BSSIDs of the location (Apple WLOC) injected into getScanResults().
                  APP-LEVEL ONLY — does not move the system/fused geolocation. */}
              <div
                className={styles.settingRow}
                title="App-level only: fills getScanResults() with the location's real BSSIDs for apps that read the Wi-Fi scan (e.g. antifraud). Does NOT change system/fused geolocation."
              >
                <Checkbox
                  checked={scenarios.bssidSyncOn}
                  onChange={(e) => scenarios.toggleBssidSync(e.target.checked)}
                >
                  Sync Wi-Fi with location (BSSID)
                </Checkbox>
              </div>
              {(scenarios.bssidApplying || scenarios.bssidError || scenarios.bssidStatus) && (
                <div className={scenarios.bssidError ? styles.error : styles.status}>
                  {scenarios.bssidApplying
                    ? 'Looking up Wi-Fi…'
                    : (scenarios.bssidError ?? scenarios.bssidStatus)}
                </div>
              )}
              {scenarios.bssidSyncOn && (
                <div className={styles.status}>
                  App-level only — apps reading the Wi-Fi scan; not system/fused location.
                </div>
              )}
            </div>
          )}

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-from-lat'>From lat</label>
              <input
                className={styles.input}
                id='walk-from-lat'
                placeholder='52.520008'
                type='text'
                value={gpsStore.walkFromLat}
                onChange={(e) => gpsStore.setWalkFromLat(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-from-lon'>From lon</label>
              <input
                className={styles.input}
                id='walk-from-lon'
                placeholder='13.404954'
                type='text'
                value={gpsStore.walkFromLon}
                onChange={(e) => gpsStore.setWalkFromLon(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-to-lat'>To lat</label>
              <input
                className={styles.input}
                id='walk-to-lat'
                placeholder='52.516275'
                type='text'
                value={gpsStore.walkToLat}
                onChange={(e) => gpsStore.setWalkToLat(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-to-lon'>To lon</label>
              <input
                className={styles.input}
                id='walk-to-lon'
                placeholder='13.377704'
                type='text'
                value={gpsStore.walkToLon}
                onChange={(e) => gpsStore.setWalkToLon(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-speed'>Speed</label>
              <select
                className={styles.input}
                id='walk-speed'
                value={gpsStore.walkSpeed}
                onChange={(e) => gpsStore.setWalkSpeed(e.target.value as WalkSpeedPreset)}
              >
                {SPEED_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor='walk-profile'>Routing</label>
              <select
                className={styles.input}
                id='walk-profile'
                value={gpsStore.walkProfile}
                onChange={(e) => gpsStore.setWalkProfile(e.target.value as WalkProfile)}
              >
                {PROFILE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.actions}>
            {!gpsStore.isWalkActive && (
              <button
                className={styles.applyButton}
                disabled={!gpsStore.isWalkInputValid || gpsStore.walkIsStarting}
                type='button'
                onClick={() => { void gpsStore.startWalk() }}
              >
                {gpsStore.walkIsStarting ? 'Building route...' : 'Start walk'}
              </button>
            )}

            {gpsStore.walkBackend?.status === 'running' && (
              <button
                className={styles.presetButton}
                disabled={gpsStore.walkIsControlling}
                type='button'
                onClick={() => { void gpsStore.pauseWalk() }}
              >
                Pause
              </button>
            )}

            {gpsStore.walkBackend?.status === 'paused' && (
              <button
                className={styles.applyButton}
                disabled={gpsStore.walkIsControlling}
                type='button'
                onClick={() => { void gpsStore.resumeWalk() }}
              >
                Resume
              </button>
            )}

            {gpsStore.isWalkActive && (
              <button
                className={styles.stopButton}
                disabled={gpsStore.walkIsControlling}
                type='button'
                onClick={() => { void gpsStore.stopWalk() }}
              >
                Stop walk
              </button>
            )}

            <button
              className={styles.presetButton}
              type='button'
              title='Brandenburger Tor → Potsdamer Platz'
              onClick={() => {
                gpsStore.setWalkFromLat('52.516275')
                gpsStore.setWalkFromLon('13.377704')
                gpsStore.setWalkToLat('52.509663')
                gpsStore.setWalkToLon('13.376217')
              }}
            >
              Berlin demo
            </button>
          </div>

          {gpsStore.walkStatusText && (
            <div className={gpsStore.walkErrorMessage ? styles.error : styles.status}>
              {gpsStore.walkStatusText}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
