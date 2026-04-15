import { makeAutoObservable, runInAction } from 'mobx'
import { injectable } from 'inversify'

export interface MediaDeviceInfo {
  deviceId: string
  label: string
  kind: MediaDeviceKind
}

type AccessKind = 'audio' | 'video' | 'both'

const STORAGE_KEYS = {
  camera: 'devicehub.selectedCameraId',
  mic: 'devicehub.selectedMicId',
  speaker: 'devicehub.selectedSpeakerId',
} as const

const SESSION_KEYS = {
  initialWarmupDone: 'devicehub.mediaWarmupDone',
} as const

@injectable()
export class DeviceMediaDevicesStore {
  cameras: MediaDeviceInfo[] = []
  microphones: MediaDeviceInfo[] = []
  speakers: MediaDeviceInfo[] = []

  selectedCameraId: string | null = null
  selectedMicId: string | null = null
  selectedSpeakerId: string | null = null

  isLoading = false
  initialized = false
  hasRequestedCameraAccess = false
  hasRequestedMicAccess = false

  private onChangeHandler: (() => void) | null = null
  private focusHandler: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null
  private lifecycleListenersBound = false
  private pageInitPromise: Promise<void> | null = null
  private hasPageInitialized = false

  constructor() {
    makeAutoObservable(this)
    this.selectedCameraId = this.readStoredSelection(STORAGE_KEYS.camera)
    this.selectedMicId = this.readStoredSelection(STORAGE_KEYS.mic)
    this.selectedSpeakerId = this.readStoredSelection(STORAGE_KEYS.speaker)
  }

  async initForDevicePage(): Promise<void> {
    if (this.hasPageInitialized) {
      await this.refreshDevices()
      return
    }

    if (this.pageInitPromise) {
      await this.pageInitPromise
      return
    }

    this.pageInitPromise = (async () => {
      this.bindLifecycleRefresh()
      await this.refreshDevices()

      const shouldWarmup = !this.readSessionFlag(SESSION_KEYS.initialWarmupDone)
      if (shouldWarmup) {
        await this.warmupPermissions({ audio: true, video: true })
        this.writeSessionFlag(SESSION_KEYS.initialWarmupDone, true)
      } else {
        await this.refreshDevices()
      }

      this.hasPageInitialized = true
    })().finally(() => {
      this.pageInitPromise = null
    })

    await this.pageInitPromise
  }

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return

    runInAction(() => {
      this.isLoading = true
    })

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()

      const cameras = this.uniqueByDeviceId(
        devices
          .filter(d => d.kind === 'videoinput')
          .map(d => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${d.deviceId.slice(0, 4) || 'unknown'}`,
            kind: d.kind,
          }))
      )

      const microphones = this.uniqueByDeviceId(
        devices
          .filter(d => d.kind === 'audioinput')
          .map(d => ({
            deviceId: d.deviceId,
            label: d.label || `Mic ${d.deviceId.slice(0, 4) || 'unknown'}`,
            kind: d.kind,
          }))
      )

      const speakers = this.uniqueByDeviceId(
        devices
          .filter(d => d.kind === 'audiooutput')
          .map(d => ({
            deviceId: d.deviceId,
            label: d.label || `Speaker ${d.deviceId.slice(0, 4) || 'unknown'}`,
            kind: d.kind,
          }))
      )

      runInAction(() => {
        this.cameras = cameras
        this.microphones = microphones
        this.speakers = speakers

        this.selectedCameraId = this.normalizeSelection(this.selectedCameraId, this.cameras)
        this.selectedMicId = this.normalizeSelection(this.selectedMicId, this.microphones)
        this.selectedSpeakerId = this.normalizeSelection(this.selectedSpeakerId, this.speakers)
      })

      if (!this.initialized) {
        this.initialized = true
        this.onChangeHandler = () => {
          void this.refreshDevices()
        }
        navigator.mediaDevices.addEventListener('devicechange', this.onChangeHandler)
      }
    } catch (err) {
      console.error('[MediaDevices] Failed to enumerate:', err)
    } finally {
      runInAction(() => {
        this.isLoading = false
      })
    }
  }

  async requestAccess(kind: AccessKind): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return

    const constraints =
      kind === 'audio'
        ? { audio: true, video: false }
        : kind === 'video'
          ? { audio: false, video: true }
          : { audio: true, video: true }

    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    try {
      stream.getTracks().forEach(track => track.stop())
      if (kind === 'audio' || kind === 'both') this.hasRequestedMicAccess = true
      if (kind === 'video' || kind === 'both') this.hasRequestedCameraAccess = true
      await this.refreshDevices()
    } finally {
      stream.getTracks().forEach(track => track.stop())
    }
  }

  async warmupPermissions(options: { audio?: boolean; video?: boolean } = {}): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return

    const needsAudio = Boolean(options.audio)
    const needsVideo = Boolean(options.video)
    if (!needsAudio && !needsVideo) return

    let stream: MediaStream | null = null

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: needsAudio,
        video: needsVideo,
      })

      if (needsAudio) this.hasRequestedMicAccess = true
      if (needsVideo) this.hasRequestedCameraAccess = true
    } catch (error) {
      console.warn('[DeviceMediaDevicesStore] Warmup permissions failed:', error)
    } finally {
      stream?.getTracks().forEach(track => track.stop())
      await this.refreshDevices()
    }
  }

  selectCamera(deviceId: string | null): void {
    this.selectedCameraId = deviceId
    this.writeStoredSelection(STORAGE_KEYS.camera, deviceId)
  }

  selectMic(deviceId: string | null): void {
    this.selectedMicId = deviceId
    this.writeStoredSelection(STORAGE_KEYS.mic, deviceId)
  }

  selectSpeaker(deviceId: string | null): void {
    this.selectedSpeakerId = deviceId
    this.writeStoredSelection(STORAGE_KEYS.speaker, deviceId)
  }

  get canSelectSpeaker(): boolean {
    return typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype
  }

  dispose(): void {
    if (this.onChangeHandler) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onChangeHandler)
      this.onChangeHandler = null
    }

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler)
      this.focusHandler = null
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }

    this.lifecycleListenersBound = false
    this.initialized = false
    this.hasPageInitialized = false
    this.pageInitPromise = null
  }

  private bindLifecycleRefresh(): void {
    if (this.lifecycleListenersBound) return

    this.focusHandler = () => {
      void this.refreshDevices()
    }

    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void this.refreshDevices()
      }
    }

    window.addEventListener('focus', this.focusHandler)
    document.addEventListener('visibilitychange', this.visibilityHandler)
    this.lifecycleListenersBound = true
  }

  private normalizeSelection(selectedId: string | null, devices: MediaDeviceInfo[]): string | null {
    if (!selectedId) return null
    return devices.some(device => device.deviceId === selectedId) ? selectedId : null
  }

  private uniqueByDeviceId(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
    const seen = new Set<string>()
    const result: MediaDeviceInfo[] = []

    for (const device of devices) {
      if (!device.deviceId || seen.has(device.deviceId)) continue
      seen.add(device.deviceId)
      result.push(device)
    }

    return result
  }


  private readStoredSelection(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }

  private writeStoredSelection(key: string, value: string | null): void {
    try {
      if (value) window.localStorage.setItem(key, value)
      else window.localStorage.removeItem(key)
    } catch {
      // ignore storage issues
    }
  }

  private readSessionFlag(key: string): boolean {
    try {
      return window.sessionStorage.getItem(key) === '1'
    } catch {
      return false
    }
  }

  private writeSessionFlag(key: string, value: boolean): void {
    try {
      if (value) window.sessionStorage.setItem(key, '1')
      else window.sessionStorage.removeItem(key)
    } catch {
      // ignore storage issues
    }
  }
}
