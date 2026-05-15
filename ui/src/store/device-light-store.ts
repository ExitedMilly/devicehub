import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  lux: 'devicehub.light.lux',
}

@injectable()
@deviceConnectionRequired()
export class DeviceLightStore {
  lux = '500'

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.lux = this.readStorage(STORAGE_KEYS.lux, '500')
  }

  setLux(value: string): void {
    this.lux = value
    this.writeStorage(STORAGE_KEYS.lux, value)
  }

  applyPreset(value: number): void {
    this.setLux(String(value))
  }

  get isValid(): boolean {
    const lux = Number(this.lux.trim())
    return Number.isFinite(lux) && lux >= 0
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    const lux = Number(this.lux.trim())
    if (!Number.isFinite(lux) || lux < 0) {
      runInAction(() => {
        this.errorMessage = 'Lux must be greater than or equal to 0'
      })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/light/${encodeURIComponent(device.serial)}`

      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lux }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()

        const via = data?.appliedVia ? `via=${data.appliedVia}` : 'via=n/a'
        const physical = typeof data?.physicalLux === 'number' ? data.physicalLux : 'n/a'
        const sensor = typeof data?.sensorLux === 'number' ? data.sensorLux : 'n/a'
        const fallback = data?.fallbackReason ? ` · fallback=${data.fallbackReason}` : ''

        this.statusMessage = `Applied: ${via} · physical=${physical} · sensor=${sensor}${fallback}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply light'
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
