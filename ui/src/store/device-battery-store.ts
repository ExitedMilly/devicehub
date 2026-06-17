import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  level: 'devicehub.battery.level',
  charging: 'devicehub.battery.charging',
}

@injectable()
@deviceConnectionRequired()
export class DeviceBatteryStore {
  level = 50
  charging = false

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)

    const savedLevel = Number(this.readStorage(STORAGE_KEYS.level))
    if (Number.isFinite(savedLevel) && savedLevel >= 0 && savedLevel <= 100) {
      this.level = savedLevel
    }
    this.charging = this.readStorage(STORAGE_KEYS.charging) === 'true'
  }

  setLevel(value: number): void {
    this.level = value
    this.writeStorage(STORAGE_KEYS.level, String(value))
  }

  setCharging(value: boolean): void {
    this.charging = value
    this.writeStorage(STORAGE_KEYS.charging, value ? 'true' : 'false')
  }

  get isValid(): boolean {
    return Number.isFinite(this.level) && this.level >= 0 && this.level <= 100
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    if (!Number.isFinite(this.level) || this.level < 0 || this.level > 100) {
      runInAction(() => {
        this.errorMessage = 'Level must be between 0 and 100'
      })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/battery/${encodeURIComponent(device.serial)}`

      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: this.level, charging: this.charging }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()

        const capacity = typeof data?.capacity === 'number' ? data.capacity : 'n/a'
        const charging = data?.charging ? 'charging' : 'on battery'

        this.statusMessage = `Applied: ${capacity}% · ${charging}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply battery'
      })
    } finally {
      runInAction(() => {
        this.isApplying = false
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
