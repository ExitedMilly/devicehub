import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

interface BluetoothStatus {
  ok?: boolean
  enabled?: boolean
  state?: string | null
}

@injectable()
@deviceConnectionRequired()
export class DeviceBluetoothStore {
  enabled = false
  state: string | null = null

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  private applyStatus(data: BluetoothStatus | null): void {
    this.enabled = !!data?.enabled
    this.state = data?.state ?? null
  }

  async fetchStatus(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/bluetooth/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return
      runInAction(() => this.applyStatus(data))
    } catch {
      // ignore transient failures
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.errorMessage = 'Device serial not found' })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/bluetooth/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.applyStatus(data)
        this.statusMessage = this.enabled ? 'Bluetooth on' : 'Bluetooth off'
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to set Bluetooth'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  async toggle(): Promise<void> {
    await this.setEnabled(!this.enabled)
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    return this.enabled ? 'Bluetooth on' : 'Bluetooth off'
  }
}
