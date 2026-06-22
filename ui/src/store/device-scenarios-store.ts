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

// Small gap between module calls inside a preset so the emulator isn't hammered.
const STEP_DELAY_MS = 150

export type ScenarioPreset = 'onCharge' | 'metro' | 'reset'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  // ----- internal (non-observable) timer/loop state -----
  private cycleTimer: number | null = null
  private rotateTimer: number | null = null
  private cycleT = 0
  private cycleBusy = false
  private rotateBusy = false
  private rotateState = false

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
    runInAction(() => {
      this.cycleOn = false
      this.rotateOn = false
    })
  }
}
