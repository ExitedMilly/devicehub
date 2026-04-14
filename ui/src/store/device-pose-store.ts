import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

const STORAGE_KEYS = {
  pitch: 'devicehub.pose.pitch',
  yaw: 'devicehub.pose.yaw',
  roll: 'devicehub.pose.roll',
}

@injectable()
@deviceConnectionRequired()
export class DevicePoseStore {
  pitch = '0'
  yaw = '0'
  roll = '0'

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  lastAppliedAt: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.pitch = this.readStorage(STORAGE_KEYS.pitch, '0')
    this.yaw = this.readStorage(STORAGE_KEYS.yaw, '0')
    this.roll = this.readStorage(STORAGE_KEYS.roll, '0')
  }

  setPitch(value: string): void {
    this.pitch = value
    this.writeStorage(STORAGE_KEYS.pitch, value)
  }

  setYaw(value: string): void {
    this.yaw = value
    this.writeStorage(STORAGE_KEYS.yaw, value)
  }

  setRoll(value: string): void {
    this.roll = value
    this.writeStorage(STORAGE_KEYS.roll, value)
  }

  applyPreset(pitch: number, yaw: number, roll: number): void {
    this.setPitch(String(pitch))
    this.setYaw(String(yaw))
    this.setRoll(String(roll))
  }

  get isValid(): boolean {
    const pitch = Number(this.pitch.trim())
    const yaw = Number(this.yaw.trim())
    const roll = Number(this.roll.trim())

    return Number.isFinite(pitch) &&
      Number.isFinite(yaw) &&
      Number.isFinite(roll) &&
      pitch >= -180 &&
      pitch <= 180 &&
      yaw >= -180 &&
      yaw <= 180 &&
      roll >= -180 &&
      roll <= 180
  }

  async apply(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => {
        this.errorMessage = 'Device serial not found'
      })
      return
    }

    const pitch = Number(this.pitch.trim())
    const yaw = Number(this.yaw.trim())
    const roll = Number(this.roll.trim())

    if (!Number.isFinite(pitch) || pitch < -180 || pitch > 180) {
      runInAction(() => {
        this.errorMessage = 'Pitch must be between -180 and 180'
      })
      return
    }

    if (!Number.isFinite(yaw) || yaw < -180 || yaw > 180) {
      runInAction(() => {
        this.errorMessage = 'Yaw must be between -180 and 180'
      })
      return
    }

    if (!Number.isFinite(roll) || roll < -180 || roll > 180) {
      runInAction(() => {
        this.errorMessage = 'Roll must be between -180 and 180'
      })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/pose/${encodeURIComponent(device.serial)}`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pitch,
          yaw,
          roll,
        }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }

      runInAction(() => {
        this.lastAppliedAt = Date.now()
        this.statusMessage =
          `Applied: acc=${formatVector(data?.acceleration)} rot=${formatVector(data?.rotation)}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to apply pose'
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

function formatVector(value: unknown): string {
  if (!Array.isArray(value)) return 'n/a'
  return value
    .map((item) => typeof item === 'number' ? item.toFixed(2) : String(item))
    .join(', ')
}
