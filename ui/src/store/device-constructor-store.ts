import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

import type { DeviceBySerialStore } from '@/store/device-by-serial-store'
import type { DeviceScenariosStore, ScenarioResource } from '@/store/device-scenarios-store'

// ===================== Parameter catalog =====================
// A constructor scenario is a list of runtime params. Applying is done ENTIRELY on the
// backend (domain/scenario-apply.js), so this front-end store only authors/persists the
// definitions (over the /api/scenarios HTTP API) and triggers apply — it no longer drives
// operblock stores. Launch-time parameters (operator MCC/MNC, serialno, wifi_mac,
// initial_location) are deliberately NOT in the catalog: they cannot be changed at runtime.

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
   * Resources the active custom scenario CLAIMS in the shared resource model (green
   * highlight + newest-wins preemption vs ambients/presets/other customs). Applying is
   * on the backend now, so this is pure front-end bookkeeping; it mirrors `resources`
   * for every param that owns a device resource.
   */
  claimResources: ScenarioResource[]
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
}

// Pose presets mirror pose-section.tsx (pitch, yaw, roll). The name->angles resolution
// also lives in the backend (domain/scenario-apply.js POSE_PRESETS).
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
    resources: ['temperature'], claimResources: ['temperature'],
  },
  {
    type: 'weather.on', label: 'Weather from location', group: 'Sensors', control: 'toggle',
    defaultValue: true, resources: ['temperature', 'humidity', 'pressure'], claimResources: ['temperature', 'humidity', 'pressure'],
    hint: 'Needs "GPS location" in the same scenario.',
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
    hint: 'Needs "GPS location" in the same scenario.',
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

// Params that need a location on the backend to apply (weather/bssid read the just-set
// GPS). A scenario using them MUST also carry gps.location — the daemon can't derive one.
const LOCATION_DEPENDENT: ParamType[] = ['weather.on', 'bssid.on']

// Soft logical warnings (collision B) — advisory only, never blocking.
export function scenarioWarnings(params: ScenarioParam[]): string[] {
  const warnings: string[] = []
  const byType = new Map(params.map((p) => [p.type, p.value]))
  if (byType.get('network.airplane') === true && byType.get('network.wifi') === true) {
    warnings.push('Airplane mode ON contradicts Wi-Fi ON — the device will apply both, but Wi-Fi is normally off in airplane mode.')
  }
  return warnings
}

// ===================== Persistence helpers =====================

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* insecure context — fall through */ }
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Value validation shared by save-time checks AND load sanitization — a malformed blob
// (hand-edited file / older schema) must never throw in the UI.
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

// Keep only well-formed entries so a stale/hand-edited file can't crash the panel.
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

// ===================== Store =====================

/**
 * User-built ("Constructor") scenarios. Definitions are PER-DEVICE, persisted on the
 * manager's backend file store (/backups/scenarios.json) over the /api/scenarios HTTP
 * API — so they survive a page reload AND a manager restart, and the Type-2 schedule
 * daemon reads the same file. This store owns the CRUD (list/save/rename/remove) and
 * triggers apply; the actual device apply runs entirely on the backend
 * (domain/scenario-apply.js), the single apply path for both instant and scheduled use.
 *
 * Coordination: applying a scenario still marks it active in DeviceScenariosStore
 * (activeCustom) so it owns its resources in the shared resource model — green highlight,
 * newest-wins preemption vs ambients/presets/other customs, and the built-in Reset clears
 * it. Device-level sensor coordination (noise yielding) is handled inside scenario-apply.
 */
@injectable()
@deviceConnectionRequired()
export class DeviceConstructorStore {
  scenarios: CustomScenario[] = []
  busyId: string | null = null
  loading = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore,
    @inject(CONTAINER_IDS.deviceScenariosStore) private scenariosStore: DeviceScenariosStore
  ) {
    makeAutoObservable(this)
    void this.load()
  }

  // No listeners/timers to tear down (definitions are backend-owned). Kept so the panel
  // can call it uniformly alongside DeviceScenariosStore.dispose().
  dispose(): void { /* no-op */ }

  private async resolveSerial(): Promise<string> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) throw new Error('device serial not available')
    return device.serial
  }

  private scenariosUrl(serial: string): string {
    return `/manager-api/scenarios/${encodeURIComponent(serial)}`
  }

  // ----- persistence (backend file store) -----

  private async load(): Promise<void> {
    runInAction(() => { this.loading = true })
    try {
      const serial = await this.resolveSerial()
      const res = await managerApiFetch(this.scenariosUrl(serial))
      const data = await res.json().catch(() => null)
      if (res.ok && data?.ok && Array.isArray(data.scenarios)) {
        runInAction(() => { this.scenarios = sanitize(data.scenarios) })
      }
    } catch {
      /* device offline / not booted — keep whatever we have, retry on next reload() */
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  /** Re-fetch the saved set from the backend (e.g. after switching devices). */
  reload(): Promise<void> {
    return this.load()
  }

  // Push the whole set to the backend (PUT-style replace via POST). Optimistic: the
  // local array is already updated; a failure surfaces in errorMessage.
  private async persist(): Promise<void> {
    try {
      const serial = await this.resolveSerial()
      const res = await managerApiFetch(this.scenariosUrl(serial), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.scenarios),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        runInAction(() => { this.errorMessage = data?.error || `Save failed (HTTP ${res.status})` })
      }
    } catch (e) {
      runInAction(() => { this.errorMessage = e instanceof Error ? e.message : 'Save failed (device offline?)' })
    }
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

    // Location requirement: weather/bssid can only apply against a location, and the
    // backend apply / daemon can't derive one — the scenario must carry gps.location.
    const types = params.map((p) => p.type)
    if (LOCATION_DEPENDENT.some((t) => types.includes(t)) && !types.includes('gps.location')) {
      const which = LOCATION_DEPENDENT.filter((t) => types.includes(t)).map((t) => PARAM_DEF_MAP.get(t)!.label).join(' / ')
      errors.push(`Add "GPS location" — ${which} need a location to apply`)
    }
    return errors
  }

  private validateValue(def: ParamDef, value: ParamValue): string | null {
    return validateParamValue(def, value)
  }

  // ----- CRUD (mutate local + persist whole set) -----

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
        void this.persist()
        return id
      }
    }
    const newId = genId()
    this.scenarios.push({ id: newId, name: trimmed, params: copy })
    void this.persist()
    return newId
  }

  rename(id: string, name: string): void {
    const s = this.scenarios.find((x) => x.id === id)
    if (!s || !name.trim()) return
    s.name = name.trim()
    void this.persist()
  }

  remove(id: string): void {
    // Never yank a scenario out from under its own in-flight apply.
    if (this.busyId === id) return
    this.scenarios = this.scenarios.filter((s) => s.id !== id)
    this.scenariosStore.releaseCustomScenario(id)
    void this.persist()
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

  // ----- apply (delegated to the backend; single apply path) -----

  /**
   * Apply a saved scenario: claim its resources in the front-end model (green highlight
   * + preemption), then POST to the backend which drives the domain functions. Reports
   * the backend's per-param outcome. On a hard failure (couldn't reach the backend) the
   * claim is released so a never-applied scenario isn't left highlighted.
   */
  async applyScenario(id: string): Promise<void> {
    const scenario = this.scenarios.find((s) => s.id === id)
    if (!scenario || this.busyId) return

    runInAction(() => {
      this.busyId = id
      this.errorMessage = null
      this.statusMessage = null
    })

    // Front-end bookkeeping only: mark the scenario the active owner of its resources
    // (highlight + newest-wins preemption). Claim-empty scenarios (e.g. only network/
    // phone) apply and finish without a lasting highlight, like the built-in Reset.
    const claim = [...new Set(scenario.params.flatMap((p) => PARAM_DEF_MAP.get(p.type)?.claimResources ?? []))]
    if (claim.length > 0) this.scenariosStore.claimCustomScenario(id, claim)
    else this.scenariosStore.releaseCustomScenario(id)

    try {
      const serial = await this.resolveSerial()
      const res = await managerApiFetch(`${this.scenariosUrl(serial)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: id }),
      })
      const data = await res.json().catch(() => null)
      const failures: Array<{ type: string; error: string }> = Array.isArray(data?.failures) ? data.failures : []
      const appliedCount = Array.isArray(data?.applied) ? data.applied.length : 0

      runInAction(() => {
        if (res.ok && data?.ok) {
          this.statusMessage = `Applied "${scenario.name}" (${scenario.params.length} param${scenario.params.length === 1 ? '' : 's'})`
        } else if (res.ok && appliedCount > 0) {
          // Partial apply: at least one param reached the device — keep the claim, report the rest.
          this.errorMessage = failures.map((f) => `${f.type}: ${f.error}`).join(' · ')
        } else {
          // Nothing applied (all failed, or a hard error): release the claim so a
          // never-applied scenario isn't left highlighted after preemption.
          this.errorMessage = failures.length > 0
            ? failures.map((f) => `${f.type}: ${f.error}`).join(' · ')
            : (data?.error || `Apply failed (HTTP ${res.status})`)
          this.scenariosStore.releaseCustomScenario(id)
        }
        // Keep the "Realistic sensors" toggle in sync with what a scenario carrying
        // sensors.noise just set on the backend (only when something applied).
        if (appliedCount > 0 || (res.ok && data?.ok)) {
          const noise = scenario.params.find((p) => p.type === 'sensors.noise')
          if (noise) this.scenariosStore.reflectSensorNoise(noise.value === true)
        }
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Apply failed'
        this.scenariosStore.releaseCustomScenario(id)
      })
    } finally {
      runInAction(() => { this.busyId = null })
    }
  }
}
