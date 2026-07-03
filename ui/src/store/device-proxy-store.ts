import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiFetch } from '@/api/manager-api'

const STORAGE_KEYS = {
  host: 'devicehub.proxy.host',
  port: 'devicehub.proxy.port',
}

interface ProxyStatus {
  ok?: boolean
  enabled?: boolean
  host?: string | null
  port?: number | null
}

@injectable()
@deviceConnectionRequired()
export class DeviceProxyStore {
  host = ''
  port = '8080'
  enabled = false

  isApplying = false
  errorMessage: string | null = null
  statusMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
    this.host = this.readStorage(STORAGE_KEYS.host)
    const savedPort = this.readStorage(STORAGE_KEYS.port)
    if (savedPort) this.port = savedPort
  }

  setHost(value: string): void {
    this.host = value
    this.writeStorage(STORAGE_KEYS.host, value)
  }

  setPort(value: string): void {
    this.port = value
    this.writeStorage(STORAGE_KEYS.port, value)
  }

  get isValid(): boolean {
    const host = this.host.trim()
    const port = Number(this.port.trim())
    return host.length > 0 && !/\s/.test(host) && Number.isInteger(port) && port >= 1 && port <= 65535
  }

  private applyStatus(data: ProxyStatus | null): void {
    this.enabled = !!data?.enabled
    if (data?.enabled) {
      if (data.host) this.host = String(data.host)
      if (data.port) this.port = String(data.port)
    }
  }

  async fetchStatus(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    try {
      const url = `/manager-api/proxy/${encodeURIComponent(device.serial)}`
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
      runInAction(() => { this.errorMessage = 'Enter a host (no spaces) and a port between 1 and 65535' })
      return
    }

    runInAction(() => {
      this.isApplying = true
      this.errorMessage = null
      this.statusMessage = null
    })

    try {
      const url = `/manager-api/proxy/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: this.host.trim(), port: Number(this.port.trim()) }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.applyStatus(data)
        this.statusMessage = `Proxy on: ${data.host}:${data.port}`
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to set proxy'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  async disable(): Promise<void> {
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
      const url = `/manager-api/proxy/${encodeURIComponent(device.serial)}`
      const response = await managerApiFetch(url, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      runInAction(() => {
        this.applyStatus(data)
        this.statusMessage = 'Proxy disabled'
      })
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to disable proxy'
      })
    } finally {
      runInAction(() => { this.isApplying = false })
    }
  }

  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    return this.enabled ? `Proxy on: ${this.host}:${this.port}` : 'Proxy off'
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
