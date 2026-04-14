import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

const STORAGE_KEYS = {
  latitude: 'devicehub.gps.latitude',
  longitude: 'devicehub.gps.longitude',
}

@injectable()
@deviceConnectionRequired()
export class DeviceGpsStore {
  latitude = ''
  longitude = ''
  isApplying = false
  isStopping = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.latitude = this.readStorage(STORAGE_KEYS.latitude)
    this.longitude = this.readStorage(STORAGE_KEYS.longitude)
  }

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

      const response = await fetch(url, {
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

      const response = await fetch(url, {
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