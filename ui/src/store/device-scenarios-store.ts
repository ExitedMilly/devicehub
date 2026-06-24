import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { DeviceLightStore } from '@/store/device-light-store'
import { DeviceBatteryStore } from '@/store/device-battery-store'
import { DevicePoseStore } from '@/store/device-pose-store'
import { DeviceNetworkStore } from '@/store/device-network-store'

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
    @inject(CONTAINER_IDS.deviceNetworkStore) private network: DeviceNetworkStore
  ) {
    makeAutoObservable(this)
  }

  // ===================== Presets (one-shot) =====================

  applyPreset(name: ScenarioPreset): void {
    switch (name) {
      case 'onCharge':
        void this.runSteps(name, [
          async () => { this.battery.setCharging(true); await this.battery.apply() },
          async () => { this.pose.applyPreset(POSE_FLAT.pitch, POSE_FLAT.yaw, POSE_FLAT.roll); await this.pose.apply() },
          async () => { this.light.applyPreset(LUX.onChargeDark); await this.light.apply() },
        ])
        break
      case 'metro':
        // Weak signal + low light. Does not touch GPS or airplane mode.
        void this.runSteps(name, [
          async () => { this.network.setSignalStrong(false); await this.network.apply() },
          async () => { this.light.applyPreset(LUX.metroLow); await this.light.apply() },
        ])
        break
      case 'reset':
        void this.runSteps(name, [
          async () => { this.light.applyPreset(LUX.neutral); await this.light.apply() },
          async () => { this.pose.applyPreset(POSE_UPRIGHT.pitch, POSE_UPRIGHT.yaw, POSE_UPRIGHT.roll); await this.pose.apply() },
          async () => { this.network.setSignalStrong(true); this.network.setAirplane(false); await this.network.apply() },
          async () => { this.battery.setCharging(false); await this.battery.apply() },
        ])
        break
      case 'lowBattery':
        // Low charge, off the charger.
        void this.runSteps(name, [
          async () => { this.battery.setLevel(LOW_BATTERY_PCT); await this.battery.apply() },
          async () => { this.battery.setCharging(false); await this.battery.apply() },
        ])
        break
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
    this.cycleOn = value
    if (value) this.startCycle()
    else this.stopCycle(true)
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
    this.rotateOn = value
    if (value) this.startRotate()
    else this.stopRotate()
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
    if (!this.batteryDrainEnabled) this.startDrain()
    else this.stopDrain()
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
    })
  }
}
