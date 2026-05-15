import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  latitude: 'devicehub.gps.latitude',
  longitude: 'devicehub.gps.longitude',
  walkFromLat: 'devicehub.walk.fromLat',
  walkFromLon: 'devicehub.walk.fromLon',
  walkToLat: 'devicehub.walk.toLat',
  walkToLon: 'devicehub.walk.toLon',
  walkSpeed: 'devicehub.walk.speed',
  walkProfile: 'devicehub.walk.profile',
}

export type WalkSpeedPreset =
  | 'walking'   // 1.4 m/s
  | 'jogging'   // 2.5 m/s
  | 'running'   // 4.0 m/s
  | 'cycling'   // 5.5 m/s
  | 'driving'   // 13.9 m/s

export const WALK_SPEED_VALUES: Record<WalkSpeedPreset, number> = {
  walking: 1.4,
  jogging: 2.5,
  running: 4.0,
  cycling: 5.5,
  driving: 13.9,
}

export type WalkProfile = 'foot' | 'bike' | 'driving'

export type WalkStatus = 'idle' | 'running' | 'paused' | 'finished'

interface WalkBackendStatus {
  serial: string
  status: WalkStatus
  profile: WalkProfile
  nominalSpeed: number
  currentSpeed: number
  jitter: boolean
  jitterMeters: number
  speedVariance: boolean
  keepAliveAfterFinish: boolean
  startedAt: string | null
  finishedAt: string | null
  totalDistanceM: number
  coveredDistanceM: number
  progress: number   // 0..1
  etaSeconds: number | null
  currentPoint: { lat: number; lon: number } | null
  targetPoint: { lat: number; lon: number } | null
  polylinePoints: number
  lastError: string | null
}

@injectable()
@deviceConnectionRequired()
export class DeviceGpsStore {
  // ----- existing point GPS state -----
  latitude = ''
  longitude = ''
  isApplying = false
  isStopping = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  // ----- walk simulation state -----
  walkFromLat = ''
  walkFromLon = ''
  walkToLat = ''
  walkToLon = ''
  walkSpeed: WalkSpeedPreset = 'walking'
  walkProfile: WalkProfile = 'foot'

  walkIsStarting = false
  walkIsControlling = false  // pause/resume/stop in flight
  walkErrorMessage: string | null = null
  walkStatusMessage: string | null = null
  walkBackend: WalkBackendStatus | null = null
  private walkPollTimer: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.latitude = this.readStorage(STORAGE_KEYS.latitude)
    this.longitude = this.readStorage(STORAGE_KEYS.longitude)
    this.walkFromLat = this.readStorage(STORAGE_KEYS.walkFromLat)
    this.walkFromLon = this.readStorage(STORAGE_KEYS.walkFromLon)
    this.walkToLat = this.readStorage(STORAGE_KEYS.walkToLat)
    this.walkToLon = this.readStorage(STORAGE_KEYS.walkToLon)
    const savedSpeed = this.readStorage(STORAGE_KEYS.walkSpeed) as WalkSpeedPreset
    if (savedSpeed && savedSpeed in WALK_SPEED_VALUES) this.walkSpeed = savedSpeed
    const savedProfile = this.readStorage(STORAGE_KEYS.walkProfile) as WalkProfile
    if (savedProfile === 'foot' || savedProfile === 'bike' || savedProfile === 'driving') {
      this.walkProfile = savedProfile
    }
  }

  // ===== existing point GPS methods (unchanged) =====

  setLatitude(value: string): void {
    this.latitude = value
    this.writeStorage(STORAGE_KEYS.latitude, value)
  }

  setLongitude(value: string): void {
    this.longitude = value
    this.writeStorage(STORAGE_KEYS.longitude, value)
  }

  get isValid(): boolean {
    const lat = Number(this.latitude.trim())
    const lon = Number(this.longitude.trim())

    return Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    const lat = Number(this.latitude.trim())
    const lon = Number(this.longitude.trim())

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      runInAction(() => {
        this.errorMessage = 'Latitude must be between -90 and 90'
      })
      return
    }

    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      runInAction(() => {
        this.errorMessage = 'Longitude must be between -180 and 180'
      })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/gps/${encodeURIComponent(device.serial)}`

      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          latitude: lat,
          longitude: lon,
          provider: 'gps',
          keepAlive: true,
          intervalMs: 20000,
        }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()
        this.statusMessage = 'GPS applied, keepalive started'
        // Backend has stopped any active walk; reflect that locally.
        this.walkBackend = null
        this.stopWalkPolling()
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to set GPS'
      })
    } finally {
      runInAction(() => {
        this.isApplying = false
      })
    }
  }

  async stop(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    runInAction(() => {
      this.isStopping = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/gps/${encodeURIComponent(device.serial)}/stop`

      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.statusMessage = 'GPS keepalive stopped'
        this.walkBackend = null
        this.stopWalkPolling()
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to stop GPS'
      })
    } finally {
      runInAction(() => {
        this.isStopping = false
      })
    }
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    if (!this.lastAppliedAt) return null

    const date = new Date(this.lastAppliedAt)
    return `Applied at ${date.toLocaleTimeString()}`
  }

  // ===== walk methods =====

  setWalkFromLat(v: string): void { this.walkFromLat = v; this.writeStorage(STORAGE_KEYS.walkFromLat, v) }
  setWalkFromLon(v: string): void { this.walkFromLon = v; this.writeStorage(STORAGE_KEYS.walkFromLon, v) }
  setWalkToLat(v: string): void   { this.walkToLat = v;   this.writeStorage(STORAGE_KEYS.walkToLat, v) }
  setWalkToLon(v: string): void   { this.walkToLon = v;   this.writeStorage(STORAGE_KEYS.walkToLon, v) }
  setWalkSpeed(v: WalkSpeedPreset): void { this.walkSpeed = v; this.writeStorage(STORAGE_KEYS.walkSpeed, v) }
  setWalkProfile(v: WalkProfile): void   { this.walkProfile = v; this.writeStorage(STORAGE_KEYS.walkProfile, v) }

  get isWalkInputValid(): boolean {
    const coords = [this.walkFromLat, this.walkFromLon, this.walkToLat, this.walkToLon]
      .map(s => Number(s.trim()))
    if (coords.some(n => !Number.isFinite(n))) return false
    const [fLat, fLon, tLat, tLon] = coords
    return fLat >= -90 && fLat <= 90 && tLat >= -90 && tLat <= 90 &&
           fLon >= -180 && fLon <= 180 && tLon >= -180 && tLon <= 180
  }

  get isWalkActive(): boolean {
    return this.walkBackend?.status === 'running' || this.walkBackend?.status === 'paused'
  }

  async startWalk(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.walkErrorMessage = 'Device serial not found' })
      return
    }
    if (!this.isWalkInputValid) {
      runInAction(() => { this.walkErrorMessage = 'Invalid From/To coordinates' })
      return
    }


    const payload = {
      from: { lat: Number(this.walkFromLat), lon: Number(this.walkFromLon) },
      to:   { lat: Number(this.walkToLat),   lon: Number(this.walkToLon) },
      speed: WALK_SPEED_VALUES[this.walkSpeed],
      profile: this.walkProfile,
      jitter: false,
      speedVariance: true,
      keepAliveAfterFinish: true,
    }

    runInAction(() => {
      this.walkIsStarting = true
      this.walkErrorMessage = null
      this.walkStatusMessage = null
    })

    try {
      const url = `/manager-api/walk/${encodeURIComponent(device.serial)}/start`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.walkBackend = data.status as WalkBackendStatus
        this.walkStatusMessage = 'Walk started'
        // The backend already cleared any GPS keepalive; reflect that.
        this.statusMessage = null
        this.lastAppliedAt = null
      })
      this.startWalkPolling()
    } catch (error) {
      runInAction(() => {
        this.walkErrorMessage = error instanceof Error ? error.message : 'Failed to start walk'
      })
    } finally {
      runInAction(() => { this.walkIsStarting = false })
    }
  }

  async pauseWalk(): Promise<void>  { await this.controlWalk('pause') }
  async resumeWalk(): Promise<void> { await this.controlWalk('resume') }
  async stopWalk(): Promise<void>   { await this.controlWalk('stop') }

  private async controlWalk(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.walkErrorMessage = 'Device serial not found' })
      return
    }
    runInAction(() => {
      this.walkIsControlling = true
      this.walkErrorMessage = null
      this.walkStatusMessage = null
    })
    try {
      const url = `/manager-api/walk/${encodeURIComponent(device.serial)}/${action}`
      const response = await managerApiFetch(url, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        if (action === 'stop') {
          this.walkBackend = null
          this.walkStatusMessage = 'Walk stopped'
          this.stopWalkPolling()
        } else {
          this.walkBackend = data.status as WalkBackendStatus
          this.walkStatusMessage = `Walk ${action}d`
        }
      })
    } catch (error) {
      runInAction(() => {
        this.walkErrorMessage = error instanceof Error ? error.message : `Failed to ${action} walk`
      })
    } finally {
      runInAction(() => { this.walkIsControlling = false })
    }
  }

  private startWalkPolling(): void {
    this.stopWalkPolling()
    this.walkPollTimer = window.setInterval(() => { void this.pollWalk() }, 1000)
  }

  private stopWalkPolling(): void {
    if (this.walkPollTimer !== null) {
      window.clearInterval(this.walkPollTimer)
      this.walkPollTimer = null
    }
  }

  private async pollWalk(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/walk/${encodeURIComponent(device.serial)}/status`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return

      runInAction(() => {
        this.walkBackend = data.status as WalkBackendStatus | null
        // Backend reports finished → stop polling but keep the snapshot
        // so user sees "Finished" until they start again.
        if (!this.walkBackend || this.walkBackend.status === 'finished') {
          this.stopWalkPolling()
        }
      })
    } catch {
      // ignore transient failures, the next tick will retry
    }
  }

  get walkStatusText(): string | null {
    if (this.walkErrorMessage) return this.walkErrorMessage
    const w = this.walkBackend
    if (!w) return this.walkStatusMessage
    const pct = Math.round(w.progress * 100)
    const eta = w.etaSeconds !== null ? formatSeconds(w.etaSeconds) : '—'
    const cur = w.currentPoint
      ? `${w.currentPoint.lat.toFixed(5)}, ${w.currentPoint.lon.toFixed(5)}`
      : '—'
    const stateLabel = w.status === 'running' ? '▶' :
                       w.status === 'paused'  ? '⏸' :
                       w.status === 'finished' ? '✓' : '·'
    return `${stateLabel} ${pct}% (${w.coveredDistanceM}/${w.totalDistanceM}m)  ETA ${eta}  · ${cur}`
  }

  private readStorage(key: string): string {
    try {
      return localStorage.getItem(key) || ''
    } catch {
      return ''
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

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m ${r}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
