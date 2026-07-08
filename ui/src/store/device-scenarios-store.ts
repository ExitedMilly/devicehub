import { makeAutoObservable, runInAction, reaction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { DeviceLightStore } from '@/store/device-light-store'
import { DeviceBatteryStore } from '@/store/device-battery-store'
import { DevicePoseStore } from '@/store/device-pose-store'
import { DeviceNetworkStore } from '@/store/device-network-store'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
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
export type ScenarioResource = 'light' | 'pose' | 'signal' | 'charging' | 'batteryLevel'

type AmbientId = 'dayNight' | 'rotation' | 'drain'

// Stable key for any active resource owner — an ambient scenario or a preset.
// Lets preemption treat both kinds uniformly (no per-pair logic).
type OwnerKey = `ambient:${AmbientId}` | `preset:${ScenarioPreset}`

// Owned resources per ambient scenario (drives generic preemption).
const AMBIENT_META: Record<AmbientId, { resources: ScenarioResource[] }> = {
  dayNight: { resources: ['light'] },
  rotation: { resources: ['pose'] },
  drain: { resources: ['batteryLevel'] },
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

@injectable()
@deviceConnectionRequired()
export class DeviceScenariosStore {
  // ----- observable UI state -----
  busyPreset: ScenarioPreset | null = null
  // Presets currently "active" (own their resources). Several may coexist while
  // their resources are disjoint. `reset` is never added here.
  activePresets = new Set<ScenarioPreset>()
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
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)

    // Re-push the owned-resource set to the sensor-noise backend whenever it
    // changes (an operblock claimed/released light or pose), while noise is on —
    // so noise keeps yielding exactly the sensors an operblock currently drives.
    reaction(
      () => this.noiseOwnedKey,
      () => { if (this.sensorNoiseOn) void this.pushSensorNoise() }
    )
  }

  // ===================== Realistic sensors (noise) =====================

  // Owned resources the noise cares about (they map to sensors it drives):
  // light -> light sensor; pose -> accel/orientation/magnetometer.
  private get noiseOwnedResources(): ScenarioResource[] {
    const owned = new Set<ScenarioResource>()
    for (const o of this.activeOwners()) {
      for (const r of o.resources) if (r === 'light' || r === 'pose') owned.add(r)
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
    }
  }

  // ===================== Presets (one-shot) =====================

  applyPreset(name: ScenarioPreset): void {
    if (name === 'reset') {
      // Reset returns everything to neutral: stop all ambient, clear every
      // active preset, then run the neutral steps. Reset itself never stays active.
      for (const a of [...this.activeAmbients]) this.stopAmbientById(a.id)
      this.activePresets.clear()
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
    runInAction(() => {
      this.cycleOn = false
      this.rotateOn = false
      this.activePresets.clear()
    })
  }
}
