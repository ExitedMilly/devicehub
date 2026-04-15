import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

const STORAGE_KEYS = {
  pitch: 'devicehub.pose.pitch',
  yaw: 'devicehub.pose.yaw',
  roll: 'devicehub.pose.roll',
  scenario: 'devicehub.pose.scenario',
}

export type PoseScenarioName = 'walking' | 'cycling' | 'driving'
export type PoseScenarioStatus = 'idle' | 'running' | 'paused'

interface PoseScenarioBackendStatus {
  serial: string
  scenario: PoseScenarioName
  scenarioLabel: string
  status: PoseScenarioStatus
  base: { pitch: number; yaw: number; roll: number }
  tickHz: number
  elapsedMs: number
  startedAt: string | null
  currentPose: { pitch: number; yaw: number; roll: number } | null
  lastError: string | null
}

@injectable()
@deviceConnectionRequired()
export class DevicePoseStore {
  // ----- existing single-shot pose state -----
  pitch = '0'
  yaw = '0'
  roll = '0'

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  // ----- scenario state -----
  scenarioName: PoseScenarioName = 'walking'
  scenarioIsStarting = false
  scenarioIsControlling = false
  scenarioErrorMessage: string | null = null
  scenarioStatusMessage: string | null = null
  scenarioBackend: PoseScenarioBackendStatus | null = null
  private scenarioPollTimer: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.pitch = this.readStorage(STORAGE_KEYS.pitch, '0')
    this.yaw = this.readStorage(STORAGE_KEYS.yaw, '0')
    this.roll = this.readStorage(STORAGE_KEYS.roll, '0')
    const savedScenario = this.readStorage(STORAGE_KEYS.scenario) as PoseScenarioName
    if (savedScenario === 'walking' || savedScenario === 'cycling' || savedScenario === 'driving') {
      this.scenarioName = savedScenario
    }
  }

  // ===== existing single-shot methods (unchanged behaviour) =====

  setPitch(value: string): void {
    this.pitch = value
    this.writeStorage(STORAGE_KEYS.pitch, value)
  }

  setYaw(value: string): void {
    this.yaw = value
    this.writeStorage(STORAGE_KEYS.yaw, value)
  }

  setRoll(value: string): void {
    this.roll = value
    this.writeStorage(STORAGE_KEYS.roll, value)
  }

  applyPreset(pitch: number, yaw: number, roll: number): void {
    this.setPitch(String(pitch))
    this.setYaw(String(yaw))
    this.setRoll(String(roll))
  }

  get isValid(): boolean {
    const pitch = Number(this.pitch.trim())
    const yaw = Number(this.yaw.trim())
    const roll = Number(this.roll.trim())

    return Number.isFinite(pitch) &&
      Number.isFinite(yaw) &&
      Number.isFinite(roll) &&
      pitch >= -180 &&
      pitch <= 180 &&
      yaw >= -180 &&
      yaw <= 180 &&
      roll >= -180 &&
      roll <= 180
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    const pitch = Number(this.pitch.trim())
    const yaw = Number(this.yaw.trim())
    const roll = Number(this.roll.trim())

    if (!Number.isFinite(pitch) || pitch < -180 || pitch > 180) {
      runInAction(() => { this.errorMessage = 'Pitch must be between -180 and 180' })
      return
    }
    if (!Number.isFinite(yaw) || yaw < -180 || yaw > 180) {
      runInAction(() => { this.errorMessage = 'Yaw must be between -180 and 180' })
      return
    }
    if (!Number.isFinite(roll) || roll < -180 || roll > 180) {
      runInAction(() => { this.errorMessage = 'Roll must be between -180 and 180' })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/pose/${encodeURIComponent(device.serial)}`

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pitch, yaw, roll }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()
        this.statusMessage =
          `Applied: acc=${formatVector(data?.acceleration)} rot=${formatVector(data?.rotation)}`
        // Backend stopped any active scenario; reflect that locally.
        this.scenarioBackend = null
        this.stopScenarioPolling()
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply pose'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    if (!this.lastAppliedAt) return null

    const date = new Date(this.lastAppliedAt)
    return `Applied at ${date.toLocaleTimeString()}`
  }

  // ===== scenario methods =====

  setScenarioName(v: PoseScenarioName): void {
    this.scenarioName = v
    this.writeStorage(STORAGE_KEYS.scenario, v)
  }

  get isScenarioActive(): boolean {
    return this.scenarioBackend?.status === 'running' ||
           this.scenarioBackend?.status === 'paused'
  }

  async startScenario(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.scenarioErrorMessage = 'Device serial not found' })
      return
    }

    runInAction(() => {
      this.scenarioIsStarting = true
      this.scenarioErrorMessage = null
      this.scenarioStatusMessage = null
    })

    try {
      const url = `/manager-api/pose/${encodeURIComponent(device.serial)}/scenario/start`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: this.scenarioName }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.scenarioBackend = data.status as PoseScenarioBackendStatus
        this.scenarioStatusMessage = 'Scenario started'
        // Single-shot pose info becomes stale once scenario takes over.
        this.statusMessage = null
        this.lastAppliedAt = null
      })
      this.startScenarioPolling()
    } catch (error) {
      runInAction(() => {
        this.scenarioErrorMessage = error instanceof Error ? error.message : 'Failed to start scenario'
      })
    } finally {
      runInAction(() => { this.scenarioIsStarting = false })
    }
  }

  async pauseScenario(): Promise<void>  { await this.controlScenario('pause') }
  async resumeScenario(): Promise<void> { await this.controlScenario('resume') }
  async stopScenario(): Promise<void>   { await this.controlScenario('stop') }

  private async controlScenario(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.scenarioErrorMessage = 'Device serial not found' })
      return
    }
    runInAction(() => {
      this.scenarioIsControlling = true
      this.scenarioErrorMessage = null
      this.scenarioStatusMessage = null
    })
    try {
      const url = `/manager-api/pose/${encodeURIComponent(device.serial)}/scenario/${action}`
      const response = await fetch(url, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        if (action === 'stop') {
          this.scenarioBackend = null
          this.scenarioStatusMessage = 'Scenario stopped'
          this.stopScenarioPolling()
        } else {
          this.scenarioBackend = data.status as PoseScenarioBackendStatus
          this.scenarioStatusMessage = `Scenario ${action}d`
        }
      })
    } catch (error) {
      runInAction(() => {
        this.scenarioErrorMessage = error instanceof Error ? error.message : `Failed to ${action} scenario`
      })
    } finally {
      runInAction(() => { this.scenarioIsControlling = false })
    }
  }

  private startScenarioPolling(): void {
    this.stopScenarioPolling()
    // Poll every 1s — scenario itself runs at 10 Hz on backend, but UI only
    // needs to show the latest applied pose every second or so.
    this.scenarioPollTimer = window.setInterval(() => { void this.pollScenario() }, 1000)
  }

  private stopScenarioPolling(): void {
    if (this.scenarioPollTimer !== null) {
      window.clearInterval(this.scenarioPollTimer)
      this.scenarioPollTimer = null
    }
  }

  private async pollScenario(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/pose/${encodeURIComponent(device.serial)}/scenario/status`
      const response = await fetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return

      runInAction(() => {
        this.scenarioBackend = data.status as PoseScenarioBackendStatus | null
        if (!this.scenarioBackend) {
          // Backend forgot us (e.g. another module overrode pose) — stop polling.
          this.stopScenarioPolling()
        }
      })
    } catch {
      // ignore transient failures
    }
  }

  get scenarioStatusText(): string | null {
    if (this.scenarioErrorMessage) return this.scenarioErrorMessage
    const s = this.scenarioBackend
    if (!s) return this.scenarioStatusMessage
    const stateLabel = s.status === 'running' ? '▶' :
                       s.status === 'paused'  ? '⏸' : '·'
    const elapsed = formatSeconds(Math.floor(s.elapsedMs / 1000))
    const cur = s.currentPose
      ? `[p=${s.currentPose.pitch.toFixed(1)} y=${s.currentPose.yaw.toFixed(1)} r=${s.currentPose.roll.toFixed(1)}]`
      : '—'
    return `${stateLabel} ${s.scenarioLabel} · ${elapsed} · ${cur}`
  }

  private readStorage(key: string, fallback = ''): string {
    try {
      return localStorage.getItem(key) || fallback
    } catch {
      return fallback
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // ignore
    }
  }
}

function formatVector(value: unknown): string {
  if (!Array.isArray(value)) return 'n/a'
  return value
    .map((item) => typeof item === 'number' ? item.toFixed(2) : String(item))
    .join(', ')
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
