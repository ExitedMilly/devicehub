import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { managerApiFetch } from '@/api/manager-api'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

// UI-facing RAT tokens. The manager maps these to RADIO_TECH_* ints. Only the
// three the manual operblock exposes; NR is spoofable but has no realistic
// single-cell manual use here.
export type CellRat = 'lte' | 'umts' | 'gsm'

const STORAGE_KEYS = {
  cid: 'devicehub.cellTower.cid',
  lac: 'devicehub.cellTower.lac',
  tac: 'devicehub.cellTower.tac',
  rat: 'devicehub.cellTower.rat',
  neighbors: 'devicehub.cellTower.neighbors',
}

interface CellTowerStatus {
  ok?: boolean
  applied?: boolean
  cid?: string | null
  lac?: string | null
  tac?: string | null
  rat?: string | null
  neighbors?: string | null
  operator?: { mcc?: string | null; mnc?: string | null; name?: string | null; plmn?: string | null; locked?: boolean }
}

// RADIO_TECH_* int (as the manager returns it in status.rat) -> UI token.
function ratIntToToken(rat: string | null | undefined): CellRat | undefined {
  if (rat === '14') return 'lte'

  if (rat === '11') return 'umts'

  if (rat === '16') return 'gsm'

  return undefined
}

@injectable()
@deviceConnectionRequired()
export class DeviceCellTowerStore {
  cid = ''
  lac = ''
  tac = ''
  rat: CellRat = 'lte'
  neighbors = ''

  // Operator is bound to the instance (op-shim bakes the name at creation and it
  // cannot change at runtime). Read-only here — shown so the user knows which
  // operator the spoofed cell belongs to.
  operatorName: string | null = null
  operatorPlmn: string | null = null

  applied = false
  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.cid = this.readStorage(STORAGE_KEYS.cid)
    this.lac = this.readStorage(STORAGE_KEYS.lac)
    this.tac = this.readStorage(STORAGE_KEYS.tac)
    this.neighbors = this.readStorage(STORAGE_KEYS.neighbors)
    const savedRat = this.readStorage(STORAGE_KEYS.rat)

    if (savedRat === 'lte' || savedRat === 'umts' || savedRat === 'gsm') this.rat = savedRat
  }

  setCid(value: string): void {
    this.cid = value
    this.writeStorage(STORAGE_KEYS.cid, value)
  }

  setLac(value: string): void {
    this.lac = value
    this.writeStorage(STORAGE_KEYS.lac, value)
  }

  setTac(value: string): void {
    this.tac = value
    this.writeStorage(STORAGE_KEYS.tac, value)
  }

  setRat(value: CellRat): void {
    this.rat = value
    this.writeStorage(STORAGE_KEYS.rat, value)
  }

  setNeighbors(value: string): void {
    this.neighbors = value
    this.writeStorage(STORAGE_KEYS.neighbors, value)
  }

  private isPositiveInt(value: string, max: number): boolean {
    const n = Number(value.trim())

    return Number.isInteger(n) && n >= 0 && n <= max
  }

  get isValid(): boolean {
    // CID and LAC are required; TAC and neighbors are optional (validated server-side).
    return this.isPositiveInt(this.cid, 268435455) && this.isPositiveInt(this.lac, 65535) &&
      (this.tac.trim() === '' || this.isPositiveInt(this.tac, 65535))
  }

  private applyStatus(data: CellTowerStatus | null): void {
    this.applied = !!data?.applied
    this.operatorName = data?.operator?.name ?? null
    this.operatorPlmn = data?.operator?.plmn ?? null

    if (data?.applied) {
      if (data.cid) this.cid = String(data.cid)

      if (data.lac) this.lac = String(data.lac)

      if (data.tac) this.tac = String(data.tac)

      if (data.neighbors) this.neighbors = String(data.neighbors)
      const token = ratIntToToken(data.rat != null ? String(data.rat) : undefined)

      if (token) this.rat = token
    }
  }

  async fetchStatus(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()

    if (!device?.serial) return

    try {
      const url = `/manager-api/cell-tower/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url)
      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) return
      runInAction(() => this.applyStatus(data))
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
      runInAction(() => { this.errorMessage = 'CID (0..268435455) and LAC (0..65535) are required; TAC optional' })

      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/cell-tower/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: Number(this.cid.trim()),
          lac: Number(this.lac.trim()),
          tac: this.tac.trim() === '' ? undefined : Number(this.tac.trim()),
          rat: this.rat,
          neighbors: this.neighbors.trim() || undefined,
        }),
      })
      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.applyStatus(data)
        this.statusMessage = `Cell applied: CID ${this.cid.trim()}, LAC ${this.lac.trim()} on ${this.operatorName || 'operator'}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply cell'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  async reset(): Promise<void> {
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
      const url = `/manager-api/cell-tower/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, { method: 'DELETE' })
      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.applyStatus(data)
        this.statusMessage = 'Cell reset to stock'
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to reset cell'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage

    if (this.statusMessage) return this.statusMessage

    return this.applied ? 'Cell spoof active' : 'Stock cell'
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
