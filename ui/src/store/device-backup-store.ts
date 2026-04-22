import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

interface BackupBackendStatus {
  serial: string
  exists: boolean
  sizeBytes: number | null
  sizeLabel: string | null
  createdAt: string | null
  inProgress: boolean
  operationKind: 'backup' | 'restore' | null
  progressStage: string | null
  progressDone: number | null
  progressTotal: number | null
  currentPackage: string | null
  error: string | null
}

@injectable()
@deviceConnectionRequired()
export class DeviceBackupStore {
  isCreating = false
  isRestoring = false
  isRefreshing = false
  errorMessage: string | null = null
  statusMessage: string | null = null
  backend: BackupBackendStatus | null = null

  private pollTimer: number | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  async createBackup(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.errorMessage = 'Device serial not found' })
      return
    }

    runInAction(() => {
      this.isCreating = true
      this.errorMessage = null
      this.statusMessage = null
    })
    this.startPolling()

    try {
      const url = `/manager-api/backup/${encodeURIComponent(device.serial)}`
      const response = await fetch(url, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      const elapsed = data.result?.elapsedMs
      const pkgCount = data.result?.packageCount
      runInAction(() => {
        this.statusMessage = `Backup saved (${(elapsed / 1000).toFixed(1)}s, ${pkgCount} packages)`
      })
      await this.refreshStatus()
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to create backup'
      })
    } finally {
      this.stopPolling()
      runInAction(() => { this.isCreating = false })
    }
  }

  async restoreBackup(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) {
      runInAction(() => { this.errorMessage = 'Device serial not found' })
      return
    }

    runInAction(() => {
      this.isRestoring = true
      this.errorMessage = null
      this.statusMessage = null
    })
    this.startPolling()

    try {
      const url = `/manager-api/backup/${encodeURIComponent(device.serial)}/restore`
      const response = await fetch(url, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      const report = data.report || {}
      const installed = report.packagesInstalled ?? 0
      const failed = report.packagesFailed ?? 0
      const sd = report.sdcardRestored ? 'yes' : 'no'
      const elapsed = report.elapsedMs ? `${(report.elapsedMs / 1000).toFixed(1)}s` : ''
      runInAction(() => {
        this.statusMessage = `Restored: ${installed} packages, ${failed} failed, sdcard=${sd}${elapsed ? ', ' + elapsed : ''}`
      })
      await this.refreshStatus()
    } catch (error) {
      runInAction(() => {
        this.errorMessage = error instanceof Error ? error.message : 'Failed to restore backup'
      })
    } finally {
      this.stopPolling()
      runInAction(() => { this.isRestoring = false })
    }
  }

  async refreshStatus(): Promise<void> {
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    runInAction(() => { this.isRefreshing = true })
    try {
      const url = `/manager-api/backup/${encodeURIComponent(device.serial)}/status`
      const response = await fetch(url)
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) return
      runInAction(() => {
        this.backend = data.status as BackupBackendStatus
      })
    } catch {
      // transient; keep previous state
    } finally {
      runInAction(() => { this.isRefreshing = false })
    }
  }

  // --- progress polling ---
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => { void this.refreshStatus() }, 2000)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // --- computed text ---
  get statusText(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.statusMessage) return this.statusMessage
    const b = this.backend
    if (!b) return null

    if (b.inProgress) {
      const kind = b.operationKind === 'restore' ? 'Restoring' : 'Backing up'
      const stage = b.progressStage ? ` · ${b.progressStage}` : ''
      const progress = (b.progressDone != null && b.progressTotal != null)
        ? ` (${b.progressDone}/${b.progressTotal})`
        : ''
      const pkg = b.currentPackage ? ` · ${b.currentPackage}` : ''
      return `${kind}${stage}${progress}${pkg}...`
    }

    if (!b.exists) return 'No backup yet'
    const parts: string[] = ['Backup exists']
    if (b.createdAt) parts.push(new Date(b.createdAt).toLocaleString())
    if (b.sizeLabel) parts.push(b.sizeLabel)
    return parts.join(' · ')
  }

  get canRestore(): boolean {
    return !!(this.backend?.exists && !this.isCreating && !this.isRestoring && !this.backend?.inProgress)
  }

  get isBusy(): boolean {
    return this.isCreating || this.isRestoring || !!this.backend?.inProgress
  }
}
