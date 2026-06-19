import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  signalStrong: 'devicehub.network.signalStrong',
  networkType: 'devicehub.network.networkType',
  registration: 'devicehub.network.registration',
  wifi: 'devicehub.network.wifi',
  airplane: 'devicehub.network.airplane',
}

const NETWORK_TYPES = ['gprs', 'edge', 'umts', 'hsdpa', 'lte']
const REGISTRATION_STATES = ['home', 'roaming', 'searching', 'unregistered']

@injectable()
@deviceConnectionRequired()
export class DeviceNetworkStore {
  signalStrong = true
  networkType = 'lte'
  registration = 'home'
  wifi = true
  airplane = false

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)

    const savedSignal = this.readStorage(STORAGE_KEYS.signalStrong)
    if (savedSignal === 'true' || savedSignal === 'false') this.signalStrong = savedSignal === 'true'
    const savedType = this.readStorage(STORAGE_KEYS.networkType)
    if (NETWORK_TYPES.includes(savedType)) this.networkType = savedType
    const savedReg = this.readStorage(STORAGE_KEYS.registration)
    if (REGISTRATION_STATES.includes(savedReg)) this.registration = savedReg
    const savedWifi = this.readStorage(STORAGE_KEYS.wifi)
    if (savedWifi === 'true' || savedWifi === 'false') this.wifi = savedWifi === 'true'
    const savedAirplane = this.readStorage(STORAGE_KEYS.airplane)
    if (savedAirplane === 'true' || savedAirplane === 'false') this.airplane = savedAirplane === 'true'
  }

  setSignalStrong(value: boolean): void {
    this.signalStrong = value
    this.writeStorage(STORAGE_KEYS.signalStrong, value ? 'true' : 'false')
  }

  setNetworkType(value: string): void {
    this.networkType = value
    this.writeStorage(STORAGE_KEYS.networkType, value)
  }

  setRegistration(value: string): void {
    this.registration = value
    this.writeStorage(STORAGE_KEYS.registration, value)
  }

  setWifi(value: boolean): void {
    this.wifi = value
    this.writeStorage(STORAGE_KEYS.wifi, value ? 'true' : 'false')
  }

  setAirplane(value: boolean): void {
    this.airplane = value
    this.writeStorage(STORAGE_KEYS.airplane, value ? 'true' : 'false')
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/network/${encodeURIComponent(device.serial)}`

      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signalProfile: this.signalStrong ? 4 : 0,
          networkType: this.networkType,
          registration: this.registration,
          wifi: this.wifi,
          airplane: this.airplane,
        }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()

        const networkType = this.networkType
        const registration = this.registration
        const wifi = typeof data?.wifi === 'boolean' ? data.wifi : this.wifi
        const airplane = typeof data?.airplane === 'boolean' ? data.airplane : this.airplane

        this.statusMessage = `Applied: ${networkType} · ${registration} · wifi ${wifi ? 'on' : 'off'}${airplane ? ' · airplane' : ''}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply network'
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
