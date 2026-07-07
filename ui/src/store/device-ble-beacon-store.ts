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

// Read-only view of the fake BLE beacons currently in the instance's netsim.
@injectable()
@deviceConnectionRequired()
export class DeviceBleBeaconStore {
  beacons: BleBeacon[] = []
  loading = false
  loaded = false
  errorMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  async fetch(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    runInAction(() => {
      this.loading = true
      this.errorMessage = null
    })

    try {
      const url = `/manager-api/ble-beacon/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.beacons = Array.isArray(data.beacons) ? data.beacons : []
        this.loaded = true
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to load beacons'
        this.beacons = []
      })
    } finally {
      runInAction(() => {
        this.loading = false
      })
    }
  }
}
