import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

export interface BleBeaconService {
  uuid: string | null
  data: string | null
}

export interface BleBeacon {
  id: number | null
  name: string | null
  address: string | null
  scannable: boolean
  includeDeviceName: boolean
  advertiseMode: string | null
  intervalMs: number | null
  txPowerLevel: string | null
  dbm: number | null
  manufacturerData: string | null
  services: BleBeaconService[]
}

export interface NewBeaconForm {
  name: string
  mac: string
  manufacturerData: string
  serviceUuid: string
  txPower: string
  interval: string
}

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/
const HEX_RE = /^[0-9A-Fa-f]*$/

function emptyForm(): NewBeaconForm {
  return { name: '', mac: '', manufacturerData: '', serviceUuid: '', txPower: '', interval: '' }
}

// Runtime management (list / add / remove) of the fake BLE beacons in netsim.
@injectable()
@deviceConnectionRequired()
export class DeviceBleBeaconStore {
  beacons: BleBeacon[] = []
  loading = false
  loaded = false
  errorMessage: string | null = null

  form: NewBeaconForm = emptyForm()
  busy = false
  formError: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  get hasBeacons(): boolean {
    return this.beacons.length > 0
  }

  setFormField<K extends keyof NewBeaconForm>(field: K, value: NewBeaconForm[K]): void {
    this.form[field] = value
  }

  get isFormValid(): boolean {
    const name = this.form.name.trim()
    if (!name) return false
    const mac = this.form.mac.trim()
    if (mac && !MAC_RE.test(mac)) return false
    const mfg = this.form.manufacturerData.trim()
    if (mfg && (mfg.length % 2 !== 0 || !HEX_RE.test(mfg))) return false
    return true
  }

  private async urlFor(): Promise<string | null> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return null
    return `/manager-api/ble-beacon/${encodeURIComponent(device.serial)}`
  }

  private applyList(data: { beacons?: BleBeacon[] } | null): void {
    this.beacons = Array.isArray(data?.beacons) ? (data as { beacons: BleBeacon[] }).beacons : []
    this.loaded = true
  }

  async fetch(): Promise<void> {
    const base = await this.urlFor()
    if (!base) return
    runInAction(() => { this.loading = true; this.errorMessage = null })
    try {
      const response = await managerApiFetch(base)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      runInAction(() => this.applyList(data))
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to load beacons'
        this.beacons = []
      })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  async addBeacon(): Promise<void> {
    const base = await this.urlFor()
    if (!base) return
    if (!this.isFormValid) {
      runInAction(() => { this.formError = 'A name is required; MAC and manufacturer data must be valid.' })
      return
    }

    const f = this.form
    const spec = {
      name: f.name.trim(),
      mac: f.mac.trim() || undefined,
      manufacturer_data: f.manufacturerData.trim() || undefined,
      service_uuid: f.serviceUuid.trim() || undefined,
      tx_power: f.txPower || undefined,
      interval: f.interval || undefined,
    }

    runInAction(() => { this.busy = true; this.formError = null; this.errorMessage = null })
    try {
      const response = await managerApiFetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      runInAction(() => {
        this.applyList(data)
        this.form = emptyForm()
      })
    } catch (error) {
      runInAction(() => { this.formError = error instanceof Error ? error.message : 'Failed to add beacon' })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }

  async removeBeacon(beacon: BleBeacon): Promise<void> {
    const base = await this.urlFor()
    if (!base) return
    const identifier = beacon.id != null ? String(beacon.id) : (beacon.name || '')
    if (!identifier) return

    runInAction(() => { this.busy = true; this.formError = null; this.errorMessage = null })
    try {
      const response = await managerApiFetch(`${base}/${encodeURIComponent(identifier)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      runInAction(() => this.applyList(data))
    } catch (error) {
      runInAction(() => { this.formError = error instanceof Error ? error.message : 'Failed to remove beacon' })
    } finally {
      runInAction(() => { this.busy = false })
    }
  }
}
