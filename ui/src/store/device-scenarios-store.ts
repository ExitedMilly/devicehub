import { makeAutoObservable, runInAction, reaction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { DeviceLightStore } from '@/store/device-light-store'
import { DeviceBatteryStore } from '@/store/device-battery-store'
import { DevicePoseStore } from '@/store/device-pose-store'
import { DeviceNetworkStore } from '@/store/device-network-store'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { DeviceGpsStore } from '@/store/device-gps-store'
import { managerApiFetch } from '@/api/manager-api'

// ===========================================================================
// Calibration defaults — tweak freely. Every magic number a scenario applies
// lives here so it can be tuned without touching the orchestration logic.
// ===========================================================================

// Light (lux), aligned with the Light module's own presets
// (Dark 0 / Dim 10 / Room 50 / Office 300 / Bright 1000 / Outdoor 10000).
const LUX = {
  onChargeDark: 0, // "On charge" — dark
  metroLow: 10,    // "Metro"     — low
  neutral: 100,    // "Reset" / cycle-off — medium
}

// Pose presets (pitch, yaw, roll) in degrees. pitch 0 ≈ lying flat (screen up),
// pitch 90 ≈ upright; roll 90 ≈ landscape.
const POSE_FLAT = { pitch: 0, yaw: 0, roll: 0 }       // On charge: lying flat
const POSE_UPRIGHT = { pitch: 90, yaw: 0, roll: 0 }   // Reset: vertical
const POSE_PORTRAIT = { pitch: 0, yaw: 0, roll: 0 }   // rotation: portrait
const POSE_LANDSCAPE = { pitch: 0, yaw: 0, roll: 90 } // rotation: landscape

// Ambient: Day/Night light cycle bounds + cadence.
const CYCLE_LUX_MIN = 0
const CYCLE_LUX_MAX = 1000
const CYCLE_TICK_SEC = 3 // how often the cycle nudges the light
const DEFAULT_CYCLE_PERIOD_SEC = 60
const MIN_CYCLE_PERIOD_SEC = 4

// Ambient: periodic rotation cadence.
const DEFAULT_ROTATE_INTERVAL_SEC = 20
const MIN_ROTATE_INTERVAL_SEC = 2

// Ambient: manual temperature operblock (°C). Realistic sub-range; the backend
// guards a wider physical range.
const DEFAULT_TEMPERATURE_C = 25
const MIN_TEMPERATURE_C = -20
const MAX_TEMPERATURE_C = 45
// Client-side ceiling on a temperature Apply. Above the manager's 6s console
// timeout, so a slow-but-successful apply isn't cut off, but a hung/bogged manager
// surfaces "Apply failed" instead of a forever-spinning button.
const TEMPERATURE_APPLY_TIMEOUT_MS = 10000

// "Weather from location": only re-query Open-Meteo after the device has moved more
// than this many km from the last-queried point (weather varies on a km/hours scale).
// Trigger is DISTANCE, not time — a jump to another country moves far past the
// threshold and re-queries at once, where a timer would keep a stale value.
const WEATHER_DISTANCE_KM = 10
// Client-side ceiling on a weather request (backend: 8s Open-Meteo + 6s console).
// Above that we abort so a hung request can't wedge weatherFetching during a walk.
const WEATHER_APPLY_TIMEOUT_MS = 15000
// Time trigger (COMPLEMENTS the distance trigger, doesn't replace it): re-query if
// the last request is older than this even when the device hasn't moved — real
// weather drifts over hours (day↔night), so a stationary device must still refresh.
// Distance = instant trigger for movement/relocation; age = trigger for standing still.
const WEATHER_MAX_AGE_MS = 30 * 60 * 1000     // 30 min
const WEATHER_CHECK_INTERVAL_MS = 60 * 1000   // how often the age is checked

// "Sync Wi-Fi with location (BSSID)": same distance+age throttle as weather, but the
// Wi-Fi environment is LOCAL (changes over hundreds of metres), so a much smaller
// distance threshold; the tile's APs don't move, so a longer max age. APP-LEVEL ONLY —
// fills getScanResults() with the location's real BSSIDs; does NOT move system/fused
// geolocation (see domain/wifi-geo.js). Apple tiles are larger, so a longer timeout.
const BSSID_DISTANCE_KM = 0.7               // ~700 m — Wi-Fi is a local fingerprint
const BSSID_APPLY_TIMEOUT_MS = 22000
const BSSID_MAX_AGE_MS = 60 * 60 * 1000     // 1 h
const BSSID_CHECK_INTERVAL_MS = 5 * 60 * 1000 // staleness check cadence

// "Low battery" preset target (%).
const LOW_BATTERY_PCT = 15

// Ambient: battery drain bounds/cadence.
const DEFAULT_DRAIN_START_PCT = 100
const DEFAULT_DRAIN_FLOOR_PCT = 5
const DEFAULT_DRAIN_INTERVAL_SEC = 6
const MIN_DRAIN_INTERVAL_SEC = 2
const MAX_DRAIN_INTERVAL_SEC = 600

// Small gap between module calls inside a preset so the emulator isn't hammered.
const STEP_DELAY_MS = 150

export type ScenarioPreset = 'onCharge' | 'metro' | 'reset' | 'lowBattery'

// Device resources a scenario can own. Used for anti-collision between ambient
// scenarios and one-shot presets (preset always wins).
export type ScenarioResource =
  | 'light' | 'pose' | 'signal' | 'charging' | 'batteryLevel'
  | 'temperature' | 'humidity' | 'pressure'

// Resources whose sensors the "Realistic sensors" noise drives, and therefore
// must yield when an operblock owns them. Kept in sync with the backend's
// RESOURCE_SENSORS (domain/sensor-noise.js).
const NOISE_RESOURCES: ScenarioResource[] = ['light', 'pose', 'temperature', 'humidity', 'pressure']

type AmbientId = 'dayNight' | 'rotation' | 'drain' | 'temperature' | 'weather'

// Stable key for any active resource owner — an ambient scenario, a preset, or a
// user-built custom scenario (Constructor tab). Lets preemption treat all kinds
// uniformly (no per-pair logic).
type OwnerKey = `ambient:${AmbientId}` | `preset:${ScenarioPreset}` | `custom:${string}`

// Owned resources per ambient scenario (drives generic preemption).
const AMBIENT_META: Record<AmbientId, { resources: ScenarioResource[] }> = {
  dayNight: { resources: ['light'] },
  rotation: { resources: ['pose'] },
  drain: { resources: ['batteryLevel'] },
  // Manual set-and-hold (no timer); owns `temperature` so noise yields it.
  temperature: { resources: ['temperature'] },
  // "Weather from location": owns temperature + humidity + pressure (real Open-Meteo
  // values). Shares `temperature` with the manual operblock, so the generic
  // preemption makes the two mutually exclusive (newest wins) for free.
  weather: { resources: ['temperature', 'humidity', 'pressure'] },
}

// Resources each preset writes. `reset` is special-cased (stops ALL ambient).
const PRESET_RESOURCES: Record<ScenarioPreset, ScenarioResource[]> = {
  onCharge: ['charging', 'pose', 'light'],
  metro: ['light', 'signal'],
  lowBattery: ['batteryLevel', 'charging'],
  reset: [],
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampInt(value: number, lo: number, hi: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

// Great-circle distance (km) between two lat/lon points — drives the weather
// re-query threshold (distance, not time).
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

@injectable()
@deviceConnectionRequired()
export class DeviceScenariosStore {
  // ----- observable UI state -----
  busyPreset: ScenarioPreset | null = null
  // Presets currently "active" (own their resources). Several may coexist while
  // their resources are disjoint. `reset` is never added here.
  activePresets = new Set<ScenarioPreset>()
  // User-built custom scenarios (Constructor tab) currently active, id → the
  // resources they own. Enters the same generic newest-wins preemption as
  // ambients/presets; applied by DeviceConstructorStore via claimCustomScenario().
  activeCustom = new Map<string, ScenarioResource[]>()
  errorMessage: string | null = null
  statusMessage: string | null = null

  cycleOn = false
  rotateOn = false
  cyclePeriodSec = DEFAULT_CYCLE_PERIOD_SEC
  rotateIntervalSec = DEFAULT_ROTATE_INTERVAL_SEC

  batteryDrainEnabled = false
  drainStartPct = DEFAULT_DRAIN_START_PCT
  drainFloorPct = DEFAULT_DRAIN_FLOOR_PCT
  drainIntervalSec = DEFAULT_DRAIN_INTERVAL_SEC

  // Ambient "Realistic sensors": keeps all sensors slightly jittering (no dead
  // zeros). Coordinates with operblocks via the resource model — the backend is
  // told which of {light, pose} are currently owned so it skips those sensors.
  sensorNoiseOn = false

  // Ambient "Temperature" operblock: manual set-and-hold of the ambient
  // temperature sensor (°C). When on, owns the `temperature` resource so noise
  // yields the temperature sensor and the set value holds.
  temperatureOn = false
  temperatureC = DEFAULT_TEMPERATURE_C
  // Explicit-Apply feedback (so a manager timeout isn't silent): applying spinner,
  // last success message, and last error message for the Temperature popover.
  temperatureApplying = false
  temperatureStatus: string | null = null
  temperatureError: string | null = null

  // Ambient "Weather from location": when on, fetches real weather (Open-Meteo) for
  // the applied GPS location and owns temperature/humidity/pressure so noise yields
  // them. Re-queries only when the device moves > WEATHER_DISTANCE_KM (distance, not
  // time). Mutually exclusive with the manual temperature operblock via preemption.
  weatherOn = false
  weatherApplying = false
  weatherStatus: string | null = null
  weatherError: string | null = null
  // Coordinates of the last successful weather fetch (drives the distance throttle).
  private lastWeatherLat: number | null = null
  private lastWeatherLon: number | null = null
  private lastWeatherTime: number | null = null
  private weatherFetching = false
  private weatherPending = false
  private weatherTimer: number | null = null

  // Ambient "Sync Wi-Fi with location (BSSID)": injects the location's real BSSIDs
  // (Apple WLOC) into getScanResults(). APP-LEVEL ONLY — does NOT move system/fused
  // geolocation. Same distance+age throttle as weather (tuned smaller/longer for Wi-Fi).
  bssidSyncOn = false
  bssidApplying = false
  bssidStatus: string | null = null
  bssidError: string | null = null
  private lastBssidLat: number | null = null
  private lastBssidLon: number | null = null
  private lastBssidTime: number | null = null
  private bssidFetching = false
  private bssidPending = false
  private bssidTimer: number | null = null

  // ----- internal (non-observable) timer/loop state -----
  private cycleTimer: number | null = null
  private rotateTimer: number | null = null
  private cycleT = 0
  private cycleBusy = false
  private rotateBusy = false
  private rotateState = false
  private drainTimer: number | null = null
  private drainCounter = 0
  private drainBusy = false

  constructor(
    @inject(CONTAINER_IDS.deviceLightStore) private light: DeviceLightStore,
    @inject(CONTAINER_IDS.deviceBatteryStore) private battery: DeviceBatteryStore,
    @inject(CONTAINER_IDS.devicePoseStore) private pose: DevicePoseStore,
    @inject(CONTAINER_IDS.deviceNetworkStore) private network: DeviceNetworkStore,
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore,
    @inject(CONTAINER_IDS.deviceGpsStore) private gpsStore: DeviceGpsStore
  ) {
    makeAutoObservable(this)

    // Re-push the owned-resource set to the sensor-noise backend whenever it
    // changes (an operblock claimed/released light or pose), while noise is on —
    // so noise keeps yielding exactly the sensors an operblock currently drives.
    reaction(
      () => this.noiseOwnedKey,
      () => { if (this.sensorNoiseOn) void this.pushSensorNoise() }
    )

    // While "Weather from location" is on, re-fetch weather when the applied GPS
    // location changes (distance-throttled inside maybeFetchWeather). The key also
    // covers the initial fetch when the feature is toggled on.
    reaction(
      () => this.weatherLocationKey,
      () => { if (this.weatherOn) void this.maybeFetchWeather() }
    )

    // Same pattern for BSSID-sync: re-inject the location's Wi-Fi BSSIDs when the
    // applied/walk location changes (distance-throttled inside maybeFetchBssid).
    reaction(
      () => this.bssidLocationKey,
      () => { if (this.bssidSyncOn) void this.maybeFetchBssid() }
    )
  }

  // ===================== Realistic sensors (noise) =====================

  // Owned resources the noise cares about (they map to sensors it drives):
  // light -> light sensor; pose -> accel/orientation/magnetometer.
  private get noiseOwnedResources(): ScenarioResource[] {
    const owned = new Set<ScenarioResource>()
    for (const o of this.activeOwners()) {
      for (const r of o.resources) if (NOISE_RESOURCES.includes(r)) owned.add(r)
    }
    return Array.from(owned)
  }

  private get noiseOwnedKey(): string {
    return this.noiseOwnedResources.slice().sort().join(',')
  }

  private async pushSensorNoise(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/sensor-noise/${encodeURIComponent(device.serial)}`
      await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: this.sensorNoiseOn, owned: this.noiseOwnedResources }),
      })
    } catch {
      // transient — the reaction / next toggle will re-sync
    }
  }

  toggleSensorNoise(on: boolean): void {
    runInAction(() => { this.sensorNoiseOn = on })
    void this.pushSensorNoise()
  }

  // ===================== Ambient: Temperature operblock =====================
  // Manual set-and-hold of the ambient temperature sensor via the console. Owns
  // the `temperature` resource so sensor-noise yields the temperature sensor.

  // The °C field only SETS the value (so negatives type cleanly on commit-on-blur and
  // the value is available to the resource model). It is applied to the device
  // EXPLICITLY via the Apply button (or Enter) — never implicitly. See applyTemperatureNow().
  setTemperatureValue(value: number): void {
    runInAction(() => { this.temperatureC = clampInt(value, MIN_TEMPERATURE_C, MAX_TEMPERATURE_C) })
  }

  // Explicit apply (Apply button / Enter): push the current value to the device when
  // the operblock is active, reporting success/failure so a manager timeout isn't
  // silent. No-op when the operblock is off (nothing owns the temperature sensor).
  async applyTemperatureNow(): Promise<void> {
    if (!this.temperatureOn || this.temperatureApplying) return
    await this.applyReporting()
  }

  // Awaitable set+enable+apply for programmatic callers (custom scenarios). Same
  // semantics as setTemperatureValue + toggleTemperature(true), but it RETURNS this
  // apply's own outcome (error string, or null on success) rather than making the
  // caller read the shared temperatureError observable — that shared read could
  // reflect a later apply if the user pokes the operblock mid-scenario.
  async applyTemperatureValue(value: number): Promise<string | null> {
    this.setTemperatureValue(value)
    if (!this.temperatureOn) {
      this.preemptConflicting(AMBIENT_META.temperature.resources, 'ambient:temperature')
      runInAction(() => { this.temperatureOn = true })
      return this.enableTemperature()
    }
    return this.applyReporting()
  }

  toggleTemperature(on: boolean): void {
    if (on) {
      // Newest-wins (uniform with every owner), then claim `temperature`.
      this.preemptConflicting(AMBIENT_META.temperature.resources, 'ambient:temperature')
      runInAction(() => { this.temperatureOn = true })
      void this.enableTemperature()
    } else {
      runInAction(() => {
        this.temperatureOn = false
        this.temperatureStatus = null
        this.temperatureError = null
      })
      this.releaseTemperature()
    }
  }

  // Turning the operblock on applies the current value immediately. Order matters:
  // make noise yield the temperature sensor FIRST (so a noise tick can't overwrite our
  // set), THEN apply. Continuous operblocks self-heal; temperature is set-and-hold.
  private async enableTemperature(): Promise<string | null> {
    if (this.sensorNoiseOn) await this.pushSensorNoise()
    return this.applyReporting()
  }

  // Push this.temperatureC and reflect the outcome in the popover (applying / applied /
  // failed). Used by both the Apply button and by enabling the operblock.
  // Serialize temperature applies into a chain. Observable-by-ref (like the timer
  // fields) is harmless — it's only ever read/written inside applyReporting, never
  // in a reactive context.
  private applyChain: Promise<void> = Promise.resolve()

  private applyReporting(): Promise<string | null> {
    // Serialize applies. The old guard `if (temperatureApplying) return` DROPPED an
    // overlapping apply — harmless for a double-click, but a programmatic scenario
    // conductor awaiting it would then never POST its value AND would read a stale
    // outcome (false success). Chain instead: each apply runs after the previous one,
    // in order, so nothing is dropped and the awaited promise reflects THIS apply.
    // Snapshot the value at REQUEST time so a later setTemperatureValue can't make a
    // queued apply post a superseded value; the promise resolves to this apply's own
    // outcome (null ok / error string).
    const celsius = this.temperatureC
    const run = this.applyChain.then(() => this.runTemperatureApply(celsius))
    // A rejection must not poison the chain (runTemperatureApply already swallows).
    this.applyChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async runTemperatureApply(celsius: number): Promise<string | null> {
    runInAction(() => {
      this.temperatureApplying = true
      this.temperatureStatus = null
      this.temperatureError = null
    })
    try {
      await this.postTemperature(celsius)
      // Only report if the operblock is still on — if it was toggled off mid-apply,
      // a stale "Applied N°C" next to an off switch would be misleading.
      runInAction(() => { if (this.temperatureOn) this.temperatureStatus = `Applied ${celsius}°C` })
      return null
    } catch {
      runInAction(() => { if (this.temperatureOn) this.temperatureError = 'Apply failed — device busy' })
      return 'Apply failed — device busy'
    } finally {
      runInAction(() => { this.temperatureApplying = false })
    }
  }

  // Releasing the operblock. When noise is on, its reaction re-pushes ownership
  // (temperature dropped) and noise resumes jittering the sensor around the default,
  // so no device write is needed here. When noise is OFF, nothing else would move the
  // sensor off the held value — so neutralize it back to the default explicitly. This
  // keeps the `reset` preset's "return everything to neutral" contract for temperature
  // (light/pose already neutralize on release; temperature must too). Best-effort.
  private releaseTemperature(): void {
    if (this.sensorNoiseOn) return
    void this.postTemperature(DEFAULT_TEMPERATURE_C).catch(() => { /* best-effort */ })
  }

  // Low-level POST with a client-side timeout. Throws on network error, non-2xx, or
  // timeout so callers can surface the failure (managerApiFetch never throws on non-2xx).
  private async postTemperature(celsius: number): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) throw new Error('No device')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), TEMPERATURE_APPLY_TIMEOUT_MS)
    try {
      const url = `/manager-api/temperature/${encodeURIComponent(device.serial)}`
      const res = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ celsius }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } finally {
      window.clearTimeout(timer)
    }
  }

  // ===================== Ambient: Weather from location =====================
  // Sets real weather (Open-Meteo) for the applied GPS location; owns temperature/
  // humidity/pressure so noise yields them. Distance-throttled (not time).

  // Non-empty only while weather is on AND a location exists — so the reaction fires
  // the initial fetch (on enable) and every location change, INCLUDING the live walk
  // position (gpsStore.currentLocation follows a running walk). maybeFetchWeather's
  // 10km throttle keeps the frequent walk updates from spamming Open-Meteo.
  private get weatherLocationKey(): string {
    if (!this.weatherOn) return ''
    const loc = this.gpsStore.currentLocation
    return loc == null ? '' : `${loc.lat},${loc.lon}`
  }

  toggleWeather(on: boolean): void {
    if (on) {
      // Newest-wins: preempt the manual temperature operblock (shared `temperature`).
      this.preemptConflicting(AMBIENT_META.weather.resources, 'ambient:weather')
      runInAction(() => {
        this.weatherOn = true
        this.weatherStatus = null
        this.weatherError = null
        this.lastWeatherLat = null
        this.lastWeatherLon = null
        this.lastWeatherTime = null
      })
      // The weatherLocationKey reaction fires the initial fetch; the noiseOwnedKey
      // reaction pushes ownership (fast) so noise yields the sensors before the
      // slower Open-Meteo round-trip sets them. The timer covers standing still.
      this.startWeatherTimer()
    } else {
      runInAction(() => {
        this.weatherOn = false
        this.weatherStatus = null
        this.weatherError = null
        this.lastWeatherLat = null
        this.lastWeatherLon = null
        this.lastWeatherTime = null
        this.weatherPending = false
      })
      this.stopWeatherTimer()
      this.releaseWeather()
    }
  }

  // Periodically re-check weather staleness so a STATIONARY device still refreshes
  // (real weather drifts). maybeFetchWeather's age throttle decides whether to fetch;
  // because lastWeatherTime is stamped on every fetch, the age is always measured from
  // the last actual request (a distance-fetch resets it — no duplicate requests).
  private startWeatherTimer(): void {
    this.stopWeatherTimer()
    this.weatherTimer = window.setInterval(() => {
      if (this.weatherOn) void this.maybeFetchWeather()
    }, WEATHER_CHECK_INTERVAL_MS)
  }

  private stopWeatherTimer(): void {
    if (this.weatherTimer !== null) {
      window.clearInterval(this.weatherTimer)
      this.weatherTimer = null
    }
  }

  // Weather release: when noise is off, neutralize temperature to the default (mirrors
  // releaseTemperature so `reset` returns temperature to neutral). When noise is on,
  // its reaction resumes jittering temperature/humidity/pressure around the defaults.
  // (humidity/pressure have no sibling neutral setter — they resume once noise is on.)
  private releaseWeather(): void {
    if (this.sensorNoiseOn) return
    void this.postTemperature(DEFAULT_TEMPERATURE_C).catch(() => { /* best-effort */ })
  }

  // Fetch + apply weather for the current applied location, subject to the distance
  // throttle. Serialized (weatherFetching) so the enable + location-change reactions
  // don't overlap requests.
  private async maybeFetchWeather(): Promise<void> {
    if (!this.weatherOn) return
    // A location change arriving mid-fetch is coalesced and drained after this one
    // finishes, so a country jump inside the fetch window isn't silently lost.
    if (this.weatherFetching) { runInAction(() => { this.weatherPending = true }); return }
    const loc = this.gpsStore.currentLocation
    if (loc == null) {
      runInAction(() => { this.weatherError = 'Apply a device location first' })
      return
    }
    const lat = loc.lat
    const lon = loc.lon
    // Two triggers, OR'd: re-query on a >10km move (instant — relocation / walk) OR
    // when the last request is stale (>30 min — stationary device, weather drifts).
    // Skip only when we're both close AND fresh.
    if (this.lastWeatherLat != null && this.lastWeatherLon != null && this.lastWeatherTime != null) {
      const movedFar = haversineKm(lat, lon, this.lastWeatherLat, this.lastWeatherLon) >= WEATHER_DISTANCE_KM
      const stale = Date.now() - this.lastWeatherTime >= WEATHER_MAX_AGE_MS
      if (!movedFar && !stale) return
    }
    runInAction(() => {
      this.weatherFetching = true
      this.weatherApplying = true
      this.weatherError = null
      // Record the attempted point + time up-front so BOTH throttles gate successful
      // and failed attempts, and the age clock restarts from the actual request — so
      // a distance-driven fetch also resets the 30-min timer (no duplicate at +30min).
      this.lastWeatherLat = lat
      this.lastWeatherLon = lon
      this.lastWeatherTime = Date.now()
    })
    try {
      const result = await this.postWeather(lat, lon)
      runInAction(() => {
        if (this.weatherOn) this.weatherStatus = `${Math.round(result.temp * 10) / 10}°C from location`
      })
    } catch {
      runInAction(() => { if (this.weatherOn) this.weatherError = 'Weather unavailable' })
    } finally {
      runInAction(() => {
        this.weatherFetching = false
        this.weatherApplying = false
      })
    }
    // Drain a change that arrived while fetching: re-read the current location and
    // re-apply the distance throttle (returns without a fetch once caught up).
    if (this.weatherPending && this.weatherOn) {
      runInAction(() => { this.weatherPending = false })
      void this.maybeFetchWeather()
    }
  }

  private async postWeather(lat: number, lon: number): Promise<{ temp: number; humidity: number | null; pressure: number | null }> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) throw new Error('No device')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), WEATHER_APPLY_TIMEOUT_MS)
    try {
      const url = `/manager-api/weather/${encodeURIComponent(device.serial)}`
      const res = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lon }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return { temp: data.temp, humidity: data.humidity, pressure: data.pressure }
    } finally {
      window.clearTimeout(timer)
    }
  }

  // ===================== Sync Wi-Fi with location (BSSID) =====================
  // Injects the location's real BSSIDs (Apple WLOC) into getScanResults(). Same
  // currentLocation + distance/age throttle as weather. APP-LEVEL ONLY: it does NOT
  // move the system/fused geolocation — only apps that read getScanResults() directly
  // (e.g. antifraud GPS↔Wi-Fi cross-checks) see it. Merged with any manual fake scan.

  private get bssidLocationKey(): string {
    if (!this.bssidSyncOn) return ''
    const loc = this.gpsStore.currentLocation
    return loc == null ? '' : `${loc.lat},${loc.lon}`
  }

  toggleBssidSync(on: boolean): void {
    if (on) {
      runInAction(() => {
        this.bssidSyncOn = true
        this.bssidStatus = null
        this.bssidError = null
        this.lastBssidLat = null
        this.lastBssidLon = null
        this.lastBssidTime = null
      })
      this.startBssidTimer()
      // The bssidLocationKey reaction fires the initial injection.
    } else {
      runInAction(() => {
        this.bssidSyncOn = false
        this.bssidStatus = null
        this.bssidError = null
        this.lastBssidLat = null
        this.lastBssidLon = null
        this.lastBssidTime = null
        this.bssidPending = false
      })
      this.stopBssidTimer()
      this.releaseBssid()
    }
  }

  private startBssidTimer(): void {
    this.stopBssidTimer()
    this.bssidTimer = window.setInterval(() => {
      if (this.bssidSyncOn) void this.maybeFetchBssid()
    }, BSSID_CHECK_INTERVAL_MS)
  }

  private stopBssidTimer(): void {
    if (this.bssidTimer !== null) {
      window.clearInterval(this.bssidTimer)
      this.bssidTimer = null
    }
  }

  private async maybeFetchBssid(): Promise<void> {
    if (!this.bssidSyncOn) return
    if (this.bssidFetching) { runInAction(() => { this.bssidPending = true }); return }
    const loc = this.gpsStore.currentLocation
    if (loc == null) {
      runInAction(() => { this.bssidError = 'Apply a device location first' })
      return
    }
    const lat = loc.lat
    const lon = loc.lon
    // Re-inject on a >700m move OR when stale (>1h). Skip only when close AND fresh.
    if (this.lastBssidLat != null && this.lastBssidLon != null && this.lastBssidTime != null) {
      const movedFar = haversineKm(lat, lon, this.lastBssidLat, this.lastBssidLon) >= BSSID_DISTANCE_KM
      const stale = Date.now() - this.lastBssidTime >= BSSID_MAX_AGE_MS
      if (!movedFar && !stale) return
    }
    runInAction(() => {
      this.bssidFetching = true
      this.bssidApplying = true
      this.bssidError = null
      this.lastBssidLat = lat
      this.lastBssidLon = lon
      this.lastBssidTime = Date.now()
    })
    try {
      const result = await this.postBssid(lat, lon)
      runInAction(() => {
        if (this.bssidSyncOn) this.bssidStatus = `${result.count} BSSIDs from location`
      })
    } catch {
      runInAction(() => { if (this.bssidSyncOn) this.bssidError = 'Wi-Fi lookup unavailable' })
    } finally {
      runInAction(() => {
        this.bssidFetching = false
        this.bssidApplying = false
      })
    }
    if (this.bssidPending && this.bssidSyncOn) {
      runInAction(() => { this.bssidPending = false })
      void this.maybeFetchBssid()
    }
  }

  private async postBssid(lat: number, lon: number): Promise<{ count: number; total: number }> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) throw new Error('No device')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), BSSID_APPLY_TIMEOUT_MS)
    try {
      const url = `/manager-api/wifi-geo/${encodeURIComponent(device.serial)}`
      const res = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lon }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return { count: data.count, total: data.total }
    } finally {
      window.clearTimeout(timer)
    }
  }

  // Remove the injected location BSSIDs (the manual fake scan, if any, is untouched).
  private releaseBssid(): void {
    void (async () => {
      const device = await this.deviceBySerialStore.fetch()
      if (!device?.serial) return
      await managerApiFetch(`/manager-api/wifi-geo/${encodeURIComponent(device.serial)}`, { method: 'DELETE' })
    })().catch(() => { /* best-effort */ })
  }

  // ===================== Resource model / preemption =====================
  // Generic, map-driven collision handling: a scenario being activated preempts
  // (stops) every running ambient whose owned resources intersect its own.
  // Newest wins. Adding a scenario = a new entry in AMBIENT_META / PRESET_RESOURCES;
  // the preemption logic below never needs per-pair changes.

  private isAmbientOn(id: AmbientId): boolean {
    switch (id) {
      case 'dayNight': return this.cycleOn
      case 'rotation': return this.rotateOn
      case 'drain': return this.batteryDrainEnabled
      case 'temperature': return this.temperatureOn
      case 'weather': return this.weatherOn
    }
  }

  // Currently-running ambient scenarios + their owned resources.
  private get activeAmbients(): Array<{ id: AmbientId; resources: ScenarioResource[] }> {
    return (Object.keys(AMBIENT_META) as AmbientId[])
      .filter((id) => this.isAmbientOn(id))
      .map((id) => ({ id, resources: AMBIENT_META[id].resources }))
  }

  private resourcesOf(name: ScenarioPreset): ScenarioResource[] {
    return PRESET_RESOURCES[name]
  }

  // True when a preset is the current active owner of its resources (drives the
  // green highlight). `reset` is never active.
  isPresetActive(name: ScenarioPreset): boolean {
    return this.activePresets.has(name)
  }

  // ----- Custom scenarios (Constructor tab) as resource owners -----
  // A custom scenario claims the union of its params' resources before applying,
  // exactly like a preset: conflicting ambients/presets/customs are preempted
  // (newest wins), then the scenario is marked active (drives its green highlight).
  // Sensor noise automatically yields the claimed NOISE_RESOURCES via the
  // noiseOwnedKey reaction — no extra wiring.
  claimCustomScenario(id: string, resources: ScenarioResource[]): void {
    this.preemptConflicting(resources, `custom:${id}`)
    this.activeCustom.set(id, [...resources])
  }

  releaseCustomScenario(id: string): void {
    this.activeCustom.delete(id)
  }

  // Reflect a backend-applied sensor-noise change into this store's flag WITHOUT
  // re-pushing to the device (the backend already set it). Keeps the "Realistic
  // sensors" toggle honest and stops the noiseOwnedKey reaction from later restarting
  // a session a scenario turned off (or leaving it stale-off after a scenario turned
  // it on). A no-op if the flag already matches.
  reflectSensorNoise(on: boolean): void {
    if (this.sensorNoiseOn !== on) runInAction(() => { this.sensorNoiseOn = on })
  }

  isCustomScenarioActive(id: string): boolean {
    return this.activeCustom.has(id)
  }

  get hasActiveCustomScenarios(): boolean {
    return this.activeCustom.size > 0
  }

  // Unified view of every active resource owner — ambient scenarios AND active
  // presets — each with its resources + a deactivate() action. This uniformity
  // is what keeps preemption pair-agnostic.
  private activeOwners(): Array<{ key: OwnerKey; resources: ScenarioResource[]; deactivate: () => void }> {
    const owners: Array<{ key: OwnerKey; resources: ScenarioResource[]; deactivate: () => void }> = []
    for (const a of this.activeAmbients) {
      owners.push({ key: `ambient:${a.id}`, resources: a.resources, deactivate: () => this.stopAmbientById(a.id) })
    }
    for (const name of this.activePresets) {
      owners.push({ key: `preset:${name}`, resources: this.resourcesOf(name), deactivate: () => { this.activePresets.delete(name) } })
    }
    for (const [id, resources] of this.activeCustom) {
      // Like presets, deactivation just drops the active flag (no device write —
      // the new owner is about to take the resource over).
      owners.push({ key: `custom:${id}`, resources, deactivate: () => { this.activeCustom.delete(id) } })
    }
    return owners
  }

  // Deactivate every active owner (ambient OR preset) whose resources intersect
  // `resources`, except `exceptKey`. The single, generic, map-driven collision
  // rule — newest wins, no per-pair branches.
  private preemptConflicting(resources: ScenarioResource[], exceptKey?: OwnerKey): void {
    for (const o of this.activeOwners()) {
      if (o.key === exceptKey) continue
      if (o.resources.some((r) => resources.includes(r))) o.deactivate()
    }
  }

  // Stop an ambient via its normal stop path (no neutral light reset — the new
  // scenario is about to take that resource over).
  private stopAmbientById(id: AmbientId): void {
    switch (id) {
      case 'dayNight':
        this.cycleOn = false
        this.stopCycle(false)
        break
      case 'rotation':
        this.rotateOn = false
        this.stopRotate()
        break
      case 'drain':
        this.stopDrain()
        break
      case 'temperature':
        // Release the resource (covers `reset` and preemption). If noise is on, its
        // reaction resumes jittering the temperature sensor; if noise is off,
        // releaseTemperature() neutralizes the held value back to the default.
        this.temperatureOn = false
        this.releaseTemperature()
        break
      case 'weather':
        // Release temperature/humidity/pressure (covers `reset` and preemption). Noise
        // (if on) resumes jittering them; if noise is off, releaseWeather() neutralizes
        // temperature back to the default (same contract as the manual operblock).
        this.weatherOn = false
        this.weatherStatus = null
        this.weatherError = null
        this.lastWeatherLat = null
        this.lastWeatherLon = null
        this.lastWeatherTime = null
        this.weatherPending = false
        this.stopWeatherTimer()
        this.releaseWeather()
        break
    }
  }

  // ===================== Presets (one-shot) =====================

  applyPreset(name: ScenarioPreset): void {
    if (name === 'reset') {
      // Reset returns everything to neutral: stop all ambient, clear every
      // active preset, then run the neutral steps. Reset itself never stays active.
      for (const a of [...this.activeAmbients]) this.stopAmbientById(a.id)
      this.activePresets.clear()
      this.activeCustom.clear()
      void this.runSteps(name, this.buildPresetSteps(name))
      return
    }
    // Newest wins: preempt every conflicting owner (ambient OR preset), then mark
    // this preset active and run its steps. Re-clicking an active preset just
    // re-applies it (idempotent) and keeps it active.
    this.preemptConflicting(this.resourcesOf(name), `preset:${name}`)
    this.activePresets.add(name)
    void this.runSteps(name, this.buildPresetSteps(name))
  }

  private buildPresetSteps(name: ScenarioPreset): Array<() => Promise<void>> {
    switch (name) {
      case 'onCharge':
        return [
          async () => { this.battery.setCharging(true); await this.battery.apply() },
          async () => { this.pose.applyPreset(POSE_FLAT.pitch, POSE_FLAT.yaw, POSE_FLAT.roll); await this.pose.apply() },
          async () => { this.light.applyPreset(LUX.onChargeDark); await this.light.apply() },
        ]
      case 'metro':
        // Weak signal + low light. Does not touch GPS or airplane mode.
        return [
          async () => { this.network.setSignalStrong(false); await this.network.apply() },
          async () => { this.light.applyPreset(LUX.metroLow); await this.light.apply() },
        ]
      case 'reset':
        return [
          async () => { this.light.applyPreset(LUX.neutral); await this.light.apply() },
          async () => { this.pose.applyPreset(POSE_UPRIGHT.pitch, POSE_UPRIGHT.yaw, POSE_UPRIGHT.roll); await this.pose.apply() },
          async () => { this.network.setSignalStrong(true); this.network.setAirplane(false); await this.network.apply() },
          async () => { this.battery.setCharging(false); await this.battery.apply() },
        ]
      case 'lowBattery':
        // Low charge, off the charger.
        return [
          async () => { this.battery.setLevel(LOW_BATTERY_PCT); await this.battery.apply() },
          async () => { this.battery.setCharging(false); await this.battery.apply() },
        ]
    }
  }

  private async runSteps(name: ScenarioPreset, steps: Array<() => Promise<void>>): Promise<void> {
    runInAction(() => {
      this.busyPreset = name
      this.errorMessage = null
      this.statusMessage = null
    })
    try {
      for (let i = 0; i < steps.length; i++) {
        await steps[i]()
        if (i < steps.length - 1) await sleep(STEP_DELAY_MS)
      }
      runInAction(() => { this.statusMessage = `Applied preset: ${name}` })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : `Failed to apply preset: ${name}`
      })
    } finally {
      runInAction(() => { this.busyPreset = null })
    }
  }

  // ===================== Ambient: Day/Night light cycle =====================

  setCycleOn(value: boolean): void {
    if (value) {
      this.preemptConflicting(AMBIENT_META.dayNight.resources, 'ambient:dayNight')
      this.cycleOn = true
      this.startCycle()
    } else {
      this.cycleOn = false
      this.stopCycle(true)
    }
  }

  setCyclePeriodSec(value: number): void {
    const v = Number.isFinite(value) ? Math.max(MIN_CYCLE_PERIOD_SEC, Math.round(value)) : DEFAULT_CYCLE_PERIOD_SEC
    this.cyclePeriodSec = v
    // Running cycle reads cyclePeriodSec each tick — no restart needed.
  }

  private startCycle(): void {
    this.stopCycle(false)
    this.cycleT = 0
    this.cycleTimer = window.setInterval(() => { void this.cycleTick() }, CYCLE_TICK_SEC * 1000)
  }

  private async cycleTick(): Promise<void> {
    if (this.cycleBusy) return
    this.cycleBusy = true
    try {
      this.cycleT += CYCLE_TICK_SEC
      const period = Math.max(MIN_CYCLE_PERIOD_SEC, this.cyclePeriodSec)
      const frac = (this.cycleT % period) / period
      // Smooth dark -> bright -> dark over one period.
      const lux = Math.round(CYCLE_LUX_MIN + (CYCLE_LUX_MAX - CYCLE_LUX_MIN) * (0.5 - 0.5 * Math.cos(2 * Math.PI * frac)))
      this.light.applyPreset(lux)
      await this.light.apply()
    } catch {
      // ignore transient failures; next tick retries
    } finally {
      runInAction(() => { this.cycleBusy = false })
    }
  }

  // resetLight: only when the user turns the toggle off (still on the device).
  // On unmount/device-change we pass false — never fire a request at a device
  // we are leaving.
  private stopCycle(resetLight: boolean): void {
    if (this.cycleTimer !== null) {
      window.clearInterval(this.cycleTimer)
      this.cycleTimer = null
    }
    if (resetLight) {
      this.light.applyPreset(LUX.neutral)
      void this.light.apply()
    }
  }

  // ===================== Ambient: periodic rotation =====================

  setRotateOn(value: boolean): void {
    if (value) {
      this.preemptConflicting(AMBIENT_META.rotation.resources, 'ambient:rotation')
      this.rotateOn = true
      this.startRotate()
    } else {
      this.rotateOn = false
      this.stopRotate()
    }
  }

  setRotateIntervalSec(value: number): void {
    const v = Number.isFinite(value) ? Math.max(MIN_ROTATE_INTERVAL_SEC, Math.round(value)) : DEFAULT_ROTATE_INTERVAL_SEC
    this.rotateIntervalSec = v
    if (this.rotateOn) this.startRotate() // restart with the new interval
  }

  private startRotate(): void {
    this.stopRotate()
    this.rotateState = false
    const intervalMs = Math.max(MIN_ROTATE_INTERVAL_SEC, this.rotateIntervalSec) * 1000
    this.rotateTimer = window.setInterval(() => { void this.rotateTick() }, intervalMs)
  }

  private async rotateTick(): Promise<void> {
    if (this.rotateBusy) return
    this.rotateBusy = true
    try {
      this.rotateState = !this.rotateState
      const p = this.rotateState ? POSE_LANDSCAPE : POSE_PORTRAIT
      this.pose.applyPreset(p.pitch, p.yaw, p.roll)
      await this.pose.apply()
    } catch {
      // ignore transient failures; next tick retries
    } finally {
      runInAction(() => { this.rotateBusy = false })
    }
  }

  private stopRotate(): void {
    if (this.rotateTimer !== null) {
      window.clearInterval(this.rotateTimer)
      this.rotateTimer = null
    }
  }

  // ===================== Ambient: battery drain =====================

  setDrainStart(value: number): void {
    this.drainStartPct = clampInt(value, 1, 100)
  }

  setDrainFloor(value: number): void {
    this.drainFloorPct = clampInt(value, 0, 99)
  }

  setDrainInterval(value: number): void {
    this.drainIntervalSec = clampInt(value, MIN_DRAIN_INTERVAL_SEC, MAX_DRAIN_INTERVAL_SEC)
  }

  toggleBatteryDrain(): void {
    if (!this.batteryDrainEnabled) {
      this.preemptConflicting(AMBIENT_META.drain.resources, 'ambient:drain')
      this.startDrain()
    } else {
      this.stopDrain()
    }
  }

  // Effective floor is always strictly below the start, so the drain always moves.
  private effectiveDrainFloor(): number {
    const start = clampInt(this.drainStartPct, 1, 100)
    return clampInt(this.drainFloorPct, 0, start - 1)
  }

  private startDrain(): void {
    if (this.drainTimer !== null) return
    const start = clampInt(this.drainStartPct, 1, 100)
    this.drainCounter = start
    // Draining while charging is meaningless — force charging off.
    this.battery.setCharging(false)
    this.battery.setLevel(this.drainCounter)
    void this.battery.apply()
    this.batteryDrainEnabled = true
    const intervalMs = clampInt(this.drainIntervalSec, MIN_DRAIN_INTERVAL_SEC, MAX_DRAIN_INTERVAL_SEC) * 1000
    this.drainTimer = window.setInterval(() => { void this.drainTick() }, intervalMs)
  }

  private async drainTick(): Promise<void> {
    if (this.drainBusy) return
    this.drainBusy = true
    try {
      const floor = this.effectiveDrainFloor()
      if (this.drainCounter <= floor) { this.stopDrain(); return }
      this.drainCounter = Math.max(floor, this.drainCounter - 1)
      this.battery.setLevel(this.drainCounter)
      await this.battery.apply()
      if (this.drainCounter <= floor) this.stopDrain()
    } catch {
      // ignore transient failures; next tick retries
    } finally {
      runInAction(() => { this.drainBusy = false })
    }
  }

  private stopDrain(): void {
    if (this.drainTimer !== null) {
      window.clearInterval(this.drainTimer)
      this.drainTimer = null
    }
    // Safe whether called synchronously (toggle) or post-await (tick reached floor).
    runInAction(() => { this.batteryDrainEnabled = false })
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.busyPreset) return `Applying: ${this.busyPreset}…`
    return this.statusMessage
  }

  // Clear every timer. Called on component unmount / device change so no timer
  // keeps firing at a device we have navigated away from. No network calls here.
  dispose(): void {
    this.stopCycle(false)
    this.stopRotate()
    this.stopDrain()
    this.stopWeatherTimer()
    this.stopBssidTimer()
    runInAction(() => {
      this.cycleOn = false
      this.rotateOn = false
      this.temperatureOn = false
      this.temperatureApplying = false
      this.temperatureStatus = null
      this.temperatureError = null
      this.weatherOn = false
      this.weatherApplying = false
      this.weatherStatus = null
      this.weatherError = null
      this.lastWeatherLat = null
      this.lastWeatherLon = null
      this.lastWeatherTime = null
      this.weatherFetching = false
      this.weatherPending = false
      this.bssidSyncOn = false
      this.bssidApplying = false
      this.bssidStatus = null
      this.bssidError = null
      this.lastBssidLat = null
      this.lastBssidLon = null
      this.lastBssidTime = null
      this.bssidFetching = false
      this.bssidPending = false
      this.activePresets.clear()
      this.activeCustom.clear()
    })
  }
}
