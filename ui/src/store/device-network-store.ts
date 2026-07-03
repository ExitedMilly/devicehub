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
  fakeNetworks: 'devicehub.network.fakeNetworks',
}

const NETWORK_TYPES = ['gprs', 'edge', 'umts', 'hsdpa', 'lte']
const REGISTRATION_STATES = ['home', 'roaming', 'searching', 'unregistered']

export type FakeSecurity = 'open' | 'wpa2' | 'wpa3'
export interface FakeNetwork {
  ssid: string
  security: FakeSecurity
  signalDbm: string
  bssid: string
  bssidAuto: boolean
}

const FAKE_SECURITIES: FakeSecurity[] = ['open', 'wpa2', 'wpa3']
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/

function defaultFakeNetwork(): FakeNetwork {
  return { ssid: '', security: 'wpa2', signalDbm: '-50', bssid: '', bssidAuto: true }
}

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

  // ----- fake Wi-Fi scan (section inside the Network popup) -----
  fakeNetworks: FakeNetwork[] = [defaultFakeNetwork()]
  fakingActive = false
  fakeIsApplying = false
  fakeErrorMessage: string | null = null
  fakeStatusMessage: string | null = null

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

    const savedFake = this.readStorage(STORAGE_KEYS.fakeNetworks)
    if (savedFake) {
      try {
        const parsed = JSON.parse(savedFake)
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.fakeNetworks = parsed.map((n) => ({
            ssid: String(n?.ssid ?? ''),
            security: FAKE_SECURITIES.includes(n?.security) ? n.security : 'wpa2',
            signalDbm: String(n?.signalDbm ?? '-50'),
            bssid: String(n?.bssid ?? ''),
            bssidAuto: n?.bssidAuto !== false,
          }))
        }
      } catch {
        // ignore malformed saved list
      }
    }
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

  // ===================== Fake Wi-Fi scan =====================

  addFakeNetwork(): void {
    this.fakeNetworks.push(defaultFakeNetwork())
    this.persistFakeNetworks()
  }

  removeFakeNetwork(index: number): void {
    this.fakeNetworks.splice(index, 1)
    this.persistFakeNetworks()
  }

  updateFakeNetwork(index: number, patch: Partial<FakeNetwork>): void {
    const cur = this.fakeNetworks[index]
    if (!cur) return
    this.fakeNetworks[index] = { ...cur, ...patch }
    this.persistFakeNetworks()
  }

  get isFakeValid(): boolean {
    if (this.fakeNetworks.length === 0) return false
    return this.fakeNetworks.every((n) => {
      const ssid = n.ssid.trim()
      const dbm = Number(n.signalDbm)
      const bssidOk = n.bssidAuto || MAC_RE.test(n.bssid.trim())
      return ssid.length > 0 && ssid.length <= 32 && !/\s/.test(ssid) &&
        Number.isInteger(dbm) && dbm >= -100 && dbm <= -30 && bssidOk
    })
  }

  async fetchFakeScanState(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/fake-scan/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return
      runInAction(() => { this.fakingActive = !!data.faking })
    } catch {
      // ignore transient failures
    }
  }

  async applyFakeScan(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.fakeErrorMessage = 'Device serial not found' })
      return
    }
    if (!this.isFakeValid) {
      runInAction(() => { this.fakeErrorMessage = 'Each network needs an SSID (no spaces) and a dBm between -100 and -30' })
      return
    }

    runInAction(() => { this.fakeIsApplying = true; this.fakeErrorMessage = null; this.fakeStatusMessage = null })
    try {
      const url = `/manager-api/fake-scan/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          networks: this.fakeNetworks.map((n) => {
            const net: { ssid: string; security: FakeSecurity; signalDbm: number; bssid?: string } =
              { ssid: n.ssid.trim(), security: n.security, signalDbm: Number(n.signalDbm) }
            if (!n.bssidAuto && n.bssid.trim()) net.bssid = n.bssid.trim()
            return net
          }),
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      runInAction(() => {
        this.fakingActive = !!data.faking
        this.fakeStatusMessage = `Faking ${Array.isArray(data.networks) ? data.networks.length : 0} network(s)`
      })
    } catch (error) {
      runInAction(() => { this.fakeErrorMessage = error instanceof Error ? error.message : 'Failed to apply fake scan' })
    } finally {
      runInAction(() => { this.fakeIsApplying = false })
    }
  }

  async stopFakeScan(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.fakeErrorMessage = 'Device serial not found' })
      return
    }
    runInAction(() => { this.fakeIsApplying = true; this.fakeErrorMessage = null; this.fakeStatusMessage = null })
    try {
      const url = `/manager-api/fake-scan/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      runInAction(() => { this.fakingActive = false; this.fakeStatusMessage = 'Fake scan stopped (real scan restored)' })
    } catch (error) {
      runInAction(() => { this.fakeErrorMessage = error instanceof Error ? error.message : 'Failed to stop fake scan' })
    } finally {
      runInAction(() => { this.fakeIsApplying = false })
    }
  }

  get fakeStatusText(): string | null {
    if (this.fakeErrorMessage) return this.fakeErrorMessage
    if (this.fakeStatusMessage) return this.fakeStatusMessage
    return this.fakingActive ? 'Faking scan results' : null
  }

  private persistFakeNetworks(): void {
    this.writeStorage(STORAGE_KEYS.fakeNetworks, JSON.stringify(this.fakeNetworks))
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
