import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

import type { DeviceBatteryStore } from '@/store/device-battery-store'
import type { DeviceNetworkStore } from '@/store/device-network-store'
import type { DeviceGpsStore } from '@/store/device-gps-store'
import type { DeviceLightStore } from '@/store/device-light-store'
import type { DevicePoseStore } from '@/store/device-pose-store'
import type { DeviceBluetoothStore } from '@/store/device-bluetooth-store'
import type { DeviceProxyStore } from '@/store/device-proxy-store'
import type { DevicePhonenumberStore } from '@/store/device-phonenumber-store'
import type { DeviceScenariosStore, ScenarioResource } from '@/store/device-scenarios-store'

// ===================== Parameter catalog =====================
// The constructor is a CONDUCTOR: applying a scenario only calls the existing
// per-operblock store methods (the same set-then-apply pairs the built-in presets
// use) — no new device-facing logic lives here. Launch-time parameters (operator
// MCC/MNC, serialno, wifi_mac, initial_location) are deliberately NOT in the
// catalog: they cannot be changed at runtime.

export type ParamType =
  | 'battery.level' | 'battery.charging'
  | 'network.signal' | 'network.speed' | 'network.registration' | 'network.wifi' | 'network.airplane'
  | 'gps.location'
  | 'temperature.value' | 'weather.on'
  | 'light.lux' | 'pose.preset' | 'sensors.noise'
  | 'bluetooth.on' | 'proxy.config' | 'phone.number' | 'bssid.on'

export type ParamValue =
  | number
  | boolean
  | string
  | { lat: string; lon: string }
  | { host: string; port: string }

export interface ScenarioParam {
  type: ParamType
  value: ParamValue
}

export interface CustomScenario {
  id: string
  name: string
  params: ScenarioParam[]
}

export type ParamControl = 'slider' | 'toggle' | 'select' | 'number' | 'text' | 'coords' | 'hostport'

export interface ParamDef {
  type: ParamType
  label: string
  group: string
  control: ParamControl
  defaultValue: ParamValue
  /** Resources this param writes — drives intra-scenario conflict detection (C). */
  resources: ScenarioResource[]
  /**
   * Resources the custom scenario must CLAIM in the shared resource model when it
   * applies this param. Empty for params applied via DeviceScenariosStore toggles
   * (temperature/weather): those claim ownership themselves (ambient:temperature /
   * ambient:weather), and a duplicate custom claim would be preempted by them.
   */
  claimResources: ScenarioResource[]
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
}

// Pose presets mirror pose-section.tsx (pitch, yaw, roll).
export const POSE_PRESETS: Record<string, { label: string; pitch: number; yaw: number; roll: number }> = {
  flat: { label: 'Flat', pitch: 0, yaw: 0, roll: 0 },
  rightTilt: { label: 'Right tilt', pitch: 0, yaw: 0, roll: 90 },
  leftTilt: { label: 'Left tilt', pitch: 0, yaw: 0, roll: -90 },
  topDown: { label: 'Top down', pitch: 90, yaw: 0, roll: 0 },
  bottomUp: { label: 'Bottom up', pitch: -90, yaw: 0, roll: 0 },
}

export const PARAM_DEFS: ParamDef[] = [
  {
    type: 'battery.level', label: 'Battery level', group: 'Battery', control: 'slider',
    defaultValue: 50, min: 0, max: 100, step: 1, unit: '%',
    resources: ['batteryLevel'], claimResources: ['batteryLevel'],
  },
  {
    type: 'battery.charging', label: 'Charging', group: 'Battery', control: 'toggle',
    defaultValue: true, resources: ['charging'], claimResources: ['charging'],
  },
  {
    type: 'network.signal', label: 'Signal strength', group: 'Network', control: 'select',
    defaultValue: 'strong', resources: ['signal'], claimResources: ['signal'],
    options: [{ value: 'weak', label: 'Weak' }, { value: 'strong', label: 'Strong' }],
  },
  {
    type: 'network.speed', label: 'Network speed', group: 'Network', control: 'select',
    defaultValue: 'lte', resources: [], claimResources: [],
    options: [
      { value: 'gprs', label: 'GPRS' }, { value: 'edge', label: 'EDGE' }, { value: 'umts', label: 'UMTS' },
      { value: 'hsdpa', label: 'HSDPA' }, { value: 'lte', label: 'LTE' },
    ],
  },
  {
    type: 'network.registration', label: 'Registration', group: 'Network', control: 'select',
    defaultValue: 'home', resources: [], claimResources: [],
    options: [
      { value: 'home', label: 'Home' }, { value: 'roaming', label: 'Roaming' },
      { value: 'searching', label: 'Searching' }, { value: 'unregistered', label: 'Unregistered' },
    ],
  },
  {
    type: 'network.wifi', label: 'Wi-Fi', group: 'Network', control: 'toggle',
    defaultValue: true, resources: [], claimResources: [],
  },
  {
    type: 'network.airplane', label: 'Airplane mode', group: 'Network', control: 'toggle',
    defaultValue: false, resources: [], claimResources: [],
  },
  {
    type: 'gps.location', label: 'GPS location', group: 'Location', control: 'coords',
    defaultValue: { lat: '55.751244', lon: '37.618423' }, resources: [], claimResources: [],
  },
  {
    type: 'temperature.value', label: 'Temperature', group: 'Sensors', control: 'number',
    defaultValue: 25, min: -20, max: 45, unit: '°C',
    resources: ['temperature'], claimResources: [],
  },
  {
    type: 'weather.on', label: 'Weather from location', group: 'Sensors', control: 'toggle',
    defaultValue: true, resources: ['temperature', 'humidity', 'pressure'], claimResources: [],
    hint: 'Needs a device location (add "GPS location" or apply one first).',
  },
  {
    type: 'light.lux', label: 'Light', group: 'Sensors', control: 'number',
    defaultValue: 300, min: 0, unit: 'lux',
    resources: ['light'], claimResources: ['light'],
  },
  {
    type: 'pose.preset', label: 'Pose', group: 'Sensors', control: 'select',
    defaultValue: 'flat', resources: ['pose'], claimResources: ['pose'],
    options: Object.entries(POSE_PRESETS).map(([value, p]) => ({ value, label: p.label })),
  },
  {
    type: 'sensors.noise', label: 'Realistic sensors', group: 'Sensors', control: 'toggle',
    defaultValue: true, resources: [], claimResources: [],
  },
  {
    type: 'bluetooth.on', label: 'Bluetooth', group: 'Connectivity', control: 'toggle',
    defaultValue: true, resources: [], claimResources: [],
  },
  {
    type: 'proxy.config', label: 'HTTP proxy', group: 'Connectivity', control: 'hostport',
    defaultValue: { host: '', port: '8080' }, resources: [], claimResources: [],
  },
  {
    type: 'phone.number', label: 'Phone number', group: 'Device', control: 'text',
    defaultValue: '79001234567', resources: [], claimResources: [],
    hint: '7–15 digits',
  },
  {
    type: 'bssid.on', label: 'Sync Wi-Fi with location (BSSID)', group: 'Connectivity', control: 'toggle',
    defaultValue: true, resources: [], claimResources: [],
  },
]

export const PARAM_DEF_MAP: ReadonlyMap<ParamType, ParamDef> = new Map(PARAM_DEFS.map((d) => [d.type, d]))

// Params whose resources intersect cannot coexist in one scenario (collision C):
// with the current catalog that is exactly manual Temperature vs Weather-from-location
// (both write `temperature`). Map-driven — new params only need `resources`.
export function conflictingWith(type: ParamType, present: ParamType[]): ParamType[] {
  const def = PARAM_DEF_MAP.get(type)
  if (!def || def.resources.length === 0) return []
  return present.filter((p) => {
    if (p === type) return false
    const other = PARAM_DEF_MAP.get(p)
    return !!other && other.resources.some((r) => def.resources.includes(r))
  })
}

// Soft logical warnings (collision B) — advisory only, never blocking.
export function scenarioWarnings(params: ScenarioParam[]): string[] {
  const warnings: string[] = []
  const byType = new Map(params.map((p) => [p.type, p.value]))
  if (byType.get('network.airplane') === true && byType.get('network.wifi') === true) {
    warnings.push('Airplane mode ON contradicts Wi-Fi ON — the device will apply both, but Wi-Fi is normally off in airplane mode.')
  }
  if (byType.get('weather.on') === true && !byType.has('gps.location')) {
    warnings.push('Weather from location needs a device location — add "GPS location" to this scenario or apply one before running it.')
  }
  return warnings
}

// ===================== Persistence =====================

const STORAGE_KEY = 'orchid.constructor.scenarios.v1'

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* insecure context — fall through */ }
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Value validation shared by save-time checks AND localStorage sanitization —
// module-level so sanitize() can shape-check values before they ever reach the UI
// or the apply path (a malformed blob must not throw in either).
export function validateParamValue(def: ParamDef, value: ParamValue): string | null {
  switch (def.control) {
    case 'slider':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      if (def.min != null && value < def.min) return `must be ≥ ${def.min}`
      if (def.max != null && value > def.max) return `must be ≤ ${def.max}`
      return null
    }
    case 'toggle':
      return typeof value === 'boolean' ? null : 'must be on/off'
    case 'select':
      return typeof value === 'string' && def.options?.some((o) => o.value === value) ? null : 'invalid option'
    case 'text': {
      if (typeof value !== 'string') return 'must be text'
      if (def.type === 'phone.number' && !/^\d{7,15}$/.test(value.trim())) return 'must be 7–15 digits'
      return null
    }
    case 'coords': {
      if (!value || typeof value !== 'object' || !('lat' in value)) return 'must be coordinates'
      if (typeof value.lat !== 'string' || typeof value.lon !== 'string') return 'must be coordinates'
      const lat = Number(value.lat.trim())
      const lon = Number(value.lon.trim())
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'latitude must be between -90 and 90'
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) return 'longitude must be between -180 and 180'
      return null
    }
    case 'hostport': {
      if (!value || typeof value !== 'object' || !('host' in value)) return 'must be host:port'
      if (typeof value.host !== 'string' || typeof value.port !== 'string') return 'must be host:port'
      if (!value.host.trim() || /\s/.test(value.host.trim())) return 'host must be non-empty without spaces'
      const port = Number(value.port.trim())
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1–65535'
      return null
    }
  }
}

// Keep only well-formed entries so a corrupt/stale blob can't crash the panel or
// poison an apply run: unknown param types AND shape-invalid values are dropped.
function sanitize(raw: unknown): CustomScenario[] {
  if (!Array.isArray(raw)) return []
  const out: CustomScenario[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const { id, name, params } = s as Partial<CustomScenario>
    if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(params)) continue
    const cleanParams = params.filter((p): p is ScenarioParam => {
      if (!p || typeof p !== 'object') return false
      const def = PARAM_DEF_MAP.get((p as ScenarioParam).type)
      return !!def && validateParamValue(def, (p as ScenarioParam).value) === null
    })
    if (cleanParams.length > 0) out.push({ id, name, params: cleanParams })
  }
  return out
}

const STEP_DELAY_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ===================== Store =====================

/**
 * User-built ("Constructor") scenarios: persisted definitions + the conductor that
 * applies one by calling the existing operblock store methods, exactly like the
 * built-in presets do (set-then-apply through the per-device singleton stores).
 *
 * Coordination: before applying, the scenario claims the union of its params'
 * claimResources in DeviceScenariosStore (same generic newest-wins preemption as
 * ambients/presets — conflicting owners stop first, e.g. the day/night cycle yields
 * `light`). Params applied via DeviceScenariosStore toggles (temperature/weather)
 * claim their own ownership inside those toggles. The built-in `Reset` preset clears
 * active custom scenarios along with everything else.
 *
 * Definitions live in localStorage (device-independent); the ACTIVE state is
 * per-device, in DeviceScenariosStore.activeCustom.
 */
@injectable()
@deviceConnectionRequired()
export class DeviceConstructorStore {
  scenarios: CustomScenario[] = []
  busyId: string | null = null
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBatteryStore) private battery: DeviceBatteryStore,
    @inject(CONTAINER_IDS.deviceNetworkStore) private network: DeviceNetworkStore,
    @inject(CONTAINER_IDS.deviceGpsStore) private gps: DeviceGpsStore,
    @inject(CONTAINER_IDS.deviceLightStore) private light: DeviceLightStore,
    @inject(CONTAINER_IDS.devicePoseStore) private pose: DevicePoseStore,
    @inject(CONTAINER_IDS.deviceBluetoothStore) private bluetooth: DeviceBluetoothStore,
    @inject(CONTAINER_IDS.deviceProxyStore) private proxy: DeviceProxyStore,
    @inject(CONTAINER_IDS.devicePhonenumberStore) private phone: DevicePhonenumberStore,
    @inject(CONTAINER_IDS.deviceScenariosStore) private scenariosStore: DeviceScenariosStore
  ) {
    makeAutoObservable(this)
    this.load()
    // Definitions are global (one localStorage key for all tabs/devices): re-load on
    // cross-tab writes so a stale tab can't silently clobber another tab's scenarios.
    window.addEventListener('storage', this.onStorage)
  }

  // Remove the cross-tab listener. Called by the control panel on unmount / device
  // change (alongside DeviceScenariosStore.dispose()) so the per-device singleton
  // isn't kept alive by the window listener.
  dispose(): void {
    window.removeEventListener('storage', this.onStorage)
  }

  private onStorage = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY || e.key === null) this.load()
  }

  // ----- persistence -----

  private load(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      this.scenarios = raw ? sanitize(JSON.parse(raw)) : []
    } catch {
      this.scenarios = []
    }
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.scenarios))
    } catch { /* storage full/blocked — definitions stay in memory */ }
  }

  // ----- validation -----

  /** Full scenario validation used by save (defence in depth behind the builder UI). */
  validate(name: string, params: ScenarioParam[]): string[] {
    const errors: string[] = []
    if (!name.trim()) errors.push('Name is required')
    if (params.length === 0) errors.push('Add at least one parameter')

    const seen = new Set<ParamType>()
    for (const p of params) {
      const def = PARAM_DEF_MAP.get(p.type)
      if (!def) { errors.push(`Unknown parameter: ${p.type}`); continue }
      if (seen.has(p.type)) errors.push(`Duplicate parameter: ${def.label}`)
      seen.add(p.type)
      const err = this.validateValue(def, p.value)
      if (err) errors.push(`${def.label}: ${err}`)
    }

    // Collision C: resource conflicts inside one scenario (e.g. Temperature + Weather).
    for (const p of params) {
      for (const other of conflictingWith(p.type, params.map((x) => x.type))) {
        const a = PARAM_DEF_MAP.get(p.type)!.label
        const b = PARAM_DEF_MAP.get(other)!.label
        const msg = `"${a}" and "${b}" control the same device resource — keep only one`
        if (!errors.includes(msg) && p.type < other) errors.push(msg)
      }
    }
    return errors
  }

  private validateValue(def: ParamDef, value: ParamValue): string | null {
    return validateParamValue(def, value)
  }

  // ----- CRUD -----

  /** Create (no id) or overwrite (id given). Returns the id, or null if invalid. */
  save(name: string, params: ScenarioParam[], id?: string): string | null {
    if (this.validate(name, params).length > 0) return null
    const trimmed = name.trim()
    const copy = params.map((p) => ({ type: p.type, value: p.value }))
    if (id) {
      const existing = this.scenarios.find((s) => s.id === id)
      if (existing) {
        existing.name = trimmed
        existing.params = copy
        // The stored definition changed, so any active claim now describes a scenario
        // that was never applied — drop it; the edited scenario must be re-applied.
        this.scenariosStore.releaseCustomScenario(id)
        this.persist()
        return id
      }
    }
    const newId = genId()
    this.scenarios.push({ id: newId, name: trimmed, params: copy })
    this.persist()
    return newId
  }

  rename(id: string, name: string): void {
    const s = this.scenarios.find((x) => x.id === id)
    if (!s || !name.trim()) return
    s.name = name.trim()
    this.persist()
  }

  remove(id: string): void {
    // Never yank a scenario out from under its own in-flight apply: releasing the
    // claim mid-run would let sensor noise re-take the very sensors the remaining
    // steps are setting.
    if (this.busyId === id) return
    this.scenarios = this.scenarios.filter((s) => s.id !== id)
    this.scenariosStore.releaseCustomScenario(id)
    this.persist()
  }

  // ----- active state (delegated to the shared resource model) -----

  isActive(id: string): boolean {
    return this.scenariosStore.isCustomScenarioActive(id)
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.busyId) {
      const s = this.scenarios.find((x) => x.id === this.busyId)
      return `Applying: ${s?.name ?? 'scenario'}…`
    }
    return this.statusMessage
  }

  // ----- apply (the conductor) -----

  /**
   * Apply a saved scenario: claim its resources (newest-wins preemption stops
   * conflicting ambients/presets/customs first), then call each param's existing
   * store methods grouped per store, in a stable order, with the same inter-step
   * delay the built-in presets use. Leaf stores never throw — failures are read
   * back from their errorMessage and reported per-param.
   */
  async applyScenario(id: string): Promise<void> {
    const scenario = this.scenarios.find((s) => s.id === id)
    if (!scenario || this.busyId) return

    runInAction(() => {
      this.busyId = id
      this.errorMessage = null
      this.statusMessage = null
    })

    // Only claim-carrying scenarios get an "active" entry: a claim-empty scenario
    // (only instant one-shot writes and/or params whose toggles own resources
    // themselves) has nothing to hold, so marking it active would leave a green
    // highlight nothing can ever preempt (like `reset`, it applies and finishes).
    const claim = [...new Set(scenario.params.flatMap((p) => PARAM_DEF_MAP.get(p.type)?.claimResources ?? []))]
    if (claim.length > 0) {
      this.scenariosStore.claimCustomScenario(id, claim)
    } else {
      this.scenariosStore.releaseCustomScenario(id) // stale claim from an older definition
    }

    const byType = new Map(scenario.params.map((p) => [p.type, p.value]))
    const failures: string[] = []
    const steps: Array<() => Promise<void>> = []

    // --- Network (one apply carries all five fields) ---
    const networkTypes: ParamType[] = ['network.signal', 'network.speed', 'network.registration', 'network.wifi', 'network.airplane']
    if (networkTypes.some((t) => byType.has(t))) {
      steps.push(async () => {
        if (byType.has('network.signal')) this.network.setSignalStrong(byType.get('network.signal') === 'strong')
        if (byType.has('network.speed')) this.network.setNetworkType(byType.get('network.speed') as string)
        if (byType.has('network.registration')) this.network.setRegistration(byType.get('network.registration') as string)
        if (byType.has('network.wifi')) this.network.setWifi(byType.get('network.wifi') === true)
        if (byType.has('network.airplane')) this.network.setAirplane(byType.get('network.airplane') === true)
        await this.network.apply()
        if (this.network.errorMessage) failures.push(`Network: ${this.network.errorMessage}`)
      })
    }

    // --- Battery (one apply carries level + charging) ---
    if (byType.has('battery.level') || byType.has('battery.charging')) {
      steps.push(async () => {
        if (byType.has('battery.level')) this.battery.setLevel(byType.get('battery.level') as number)
        if (byType.has('battery.charging')) this.battery.setCharging(byType.get('battery.charging') === true)
        await this.battery.apply()
        if (this.battery.errorMessage) failures.push(`Battery: ${this.battery.errorMessage}`)
      })
    }

    // --- GPS (before weather/BSSID toggles: they read the applied location) ---
    if (byType.has('gps.location')) {
      steps.push(async () => {
        const coords = byType.get('gps.location') as { lat: string; lon: string }
        this.gps.setLatitude(coords.lat)
        this.gps.setLongitude(coords.lon)
        await this.gps.apply()
        if (this.gps.errorMessage) failures.push(`GPS: ${this.gps.errorMessage}`)
      })
    }

    // --- Proxy ---
    if (byType.has('proxy.config')) {
      steps.push(async () => {
        const cfg = byType.get('proxy.config') as { host: string; port: string }
        this.proxy.setHost(cfg.host)
        this.proxy.setPort(cfg.port)
        await this.proxy.apply()
        if (this.proxy.errorMessage) failures.push(`Proxy: ${this.proxy.errorMessage}`)
      })
    }

    // --- Phone number ---
    if (byType.has('phone.number')) {
      steps.push(async () => {
        this.phone.setNumber(byType.get('phone.number') as string)
        await this.phone.apply()
        if (this.phone.errorMessage) failures.push(`Phone: ${this.phone.errorMessage}`)
      })
    }

    // --- Bluetooth (setEnabled applies itself) ---
    if (byType.has('bluetooth.on')) {
      steps.push(async () => {
        await this.bluetooth.setEnabled(byType.get('bluetooth.on') === true)
        if (this.bluetooth.errorMessage) failures.push(`Bluetooth: ${this.bluetooth.errorMessage}`)
      })
    }

    // --- Light (set-then-apply, like the presets) ---
    if (byType.has('light.lux')) {
      steps.push(async () => {
        this.light.applyPreset(byType.get('light.lux') as number)
        await this.light.apply()
        if (this.light.errorMessage) failures.push(`Light: ${this.light.errorMessage}`)
      })
    }

    // --- Pose (set-then-apply) ---
    if (byType.has('pose.preset')) {
      steps.push(async () => {
        const preset = POSE_PRESETS[byType.get('pose.preset') as string]
        if (!preset) { failures.push('Pose: unknown preset'); return }
        this.pose.applyPreset(preset.pitch, preset.yaw, preset.roll)
        await this.pose.apply()
        if (this.pose.errorMessage) failures.push(`Pose: ${this.pose.errorMessage}`)
      })
    }

    // --- Temperature (via the scenarios-store operblock: it claims `temperature`
    //     itself; the awaitable path lets us read the REAL apply outcome) ---
    if (byType.has('temperature.value')) {
      steps.push(async () => {
        // Read THIS apply's own outcome (returned), not the shared temperatureError
        // observable — the shared field could reflect a later apply if the user pokes
        // the Temperature operblock mid-scenario.
        const tempError = await this.scenariosStore.applyTemperatureValue(byType.get('temperature.value') as number)
        if (tempError) failures.push(`Temperature: ${tempError}`)
      })
    }

    // --- Ambient toggles (own their resources themselves). Only toggle on a REAL
    //     transition: e.g. toggleWeather(false) when weather is already off would
    //     still fire releaseWeather()'s neutralize-write (25°C) into a temperature
    //     resource another operblock may own right now. ---
    if (byType.has('weather.on')) {
      steps.push(async () => {
        const want = byType.get('weather.on') === true
        if (want !== this.scenariosStore.weatherOn) this.scenariosStore.toggleWeather(want)
      })
    }
    if (byType.has('bssid.on')) {
      steps.push(async () => {
        const want = byType.get('bssid.on') === true
        if (want !== this.scenariosStore.bssidSyncOn) this.scenariosStore.toggleBssidSync(want)
      })
    }
    if (byType.has('sensors.noise')) {
      steps.push(async () => {
        const want = byType.get('sensors.noise') === true
        if (want !== this.scenariosStore.sensorNoiseOn) this.scenariosStore.toggleSensorNoise(want)
      })
    }

    try {
      for (let i = 0; i < steps.length; i++) {
        if (i > 0) await sleep(STEP_DELAY_MS)
        await steps[i]()
      }
      runInAction(() => {
        if (failures.length > 0) {
          this.errorMessage = failures.join(' · ')
        } else {
          this.statusMessage = `Applied "${scenario.name}" (${scenario.params.length} param${scenario.params.length === 1 ? '' : 's'})`
        }
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Apply failed'
      })
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
}
