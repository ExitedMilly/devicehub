import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  number: 'devicehub.phonenumber.number',
}

@injectable()
@deviceConnectionRequired()
export class DevicePhonenumberStore {
  number = ''

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.number = this.readStorage(STORAGE_KEYS.number)
  }

  setNumber(value: string): void {
    this.number = value
    this.writeStorage(STORAGE_KEYS.number, value)
  }

  get isValid(): boolean {
    return /^\d{7,15}$/.test(this.number.trim())
  }

  async fetch(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/phonenumber/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return
      runInAction(() => {
        // Only overwrite the field if the device reported a parsed number.
        if (typeof data.number === 'string' && data.number) this.number = data.number
      })
    } catch {
      // ignore transient failures
    }
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.errorMessage = 'Device serial not found' })
      return
    }
    if (!this.isValid) {
      runInAction(() => { this.errorMessage = 'Number must be 7-15 digits (no leading +)' })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/phonenumber/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: this.number.trim() }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.statusMessage = `Phone number set: ${data.number}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to set phone number'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    return null
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
