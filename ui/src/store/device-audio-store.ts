import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { DeviceMediaDevicesStore } from '@/store/device-media-devices-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'
import { managerApiWebSocket } from '@/api/manager-api'

@injectable()
@deviceConnectionRequired()
export class DeviceAudioStore {
  private websocket: WebSocket | null = null
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private audioElement: HTMLAudioElement | null = null
  private queue: Uint8Array[] = []
  private appending = false
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly maxReconnectAttempts = 5
  private readonly reconnectInterval = 3000

  isMuted = false
  volume = 0.8
  isConnected = false
  isPlaying = false
  hasAudio = false

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore,
    @inject(CONTAINER_IDS.deviceMediaDevicesStore) private mediaDevicesStore: DeviceMediaDevicesStore
  ) {
    makeAutoObservable(this)
  }

  async startAudioStreaming(): Promise<void> {
    this.disposed = false
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    const mimeType = 'audio/webm; codecs=opus'
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) return

    runInAction(() => { this.hasAudio = true })

    const audioUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/audio/${device.serial}`
    this.setupMediaSource(audioUrl, mimeType)
  }

  stopAudioStreaming(): void {
    this.disposed = true
    this.cleanup()
  }

  toggleMute(): void {
    this.isMuted = !this.isMuted
    if (this.audioElement) { this.audioElement.muted = this.isMuted }
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
    if (this.audioElement) { this.audioElement.volume = this.volume }
  }

  /** Select speaker before playback or switch current output via setSinkId */
  async switchSpeaker(deviceId: string): Promise<void> {
    this.mediaDevicesStore.selectSpeaker(deviceId)

    if (!this.audioElement) return
    try {
      await (this.audioElement as any).setSinkId(deviceId)
      this.mediaDevicesStore.selectSpeaker(deviceId)
      console.log('[DeviceAudioStore] Switched speaker to:', deviceId)
    } catch (err) {
      console.error('[DeviceAudioStore] Failed to switch speaker:', err)
    }
  }

  private setupMediaSource(audioUrl: string, mimeType: string): void {
    this.cleanup()

    this.audioElement = document.createElement('audio')
    this.audioElement.volume = this.volume
    this.audioElement.muted = this.isMuted

    // Apply selected speaker if available
    if (this.mediaDevicesStore.selectedSpeakerId && this.mediaDevicesStore.canSelectSpeaker) {
      (this.audioElement as any).setSinkId(this.mediaDevicesStore.selectedSpeakerId).catch(() => {})
    }

    this.mediaSource = new MediaSource()
    this.audioElement.src = URL.createObjectURL(this.mediaSource)

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.mediaSource || this.disposed) return
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType)
        this.sourceBuffer.mode = 'sequence'
        this.sourceBuffer.addEventListener('updateend', () => {
          this.appending = false
          this.drainQueue()
          this.tryPlay()
          this.trimBuffer()
        })
        this.sourceBuffer.addEventListener('error', () => {})
        this.connectWebSocket(audioUrl)
      } catch (e) {
        console.error('[DeviceAudioStore] Failed to create SourceBuffer:', e)
      }
    })
  }

  private connectWebSocket(url: string): void {
    if (this.disposed) return
    this.websocket = managerApiWebSocket(url)
    this.websocket.binaryType = 'arraybuffer'

    this.websocket.onopen = () => {
      runInAction(() => { this.isConnected = true; this.reconnectAttempt = 0 })
      // Refresh device list (speaker labels may need audio context)
      void this.mediaDevicesStore.refreshDevices()
    }
    this.websocket.onmessage = (event: MessageEvent) => {
      this.queue.push(new Uint8Array(event.data))
      this.drainQueue()
    }
    this.websocket.onerror = () => {}
    this.websocket.onclose = () => {
      runInAction(() => { this.isConnected = false; this.isPlaying = false })
      if (!this.disposed) { this.scheduleReconnect(url) }
    }
  }

  private drainQueue(): void {
    if (this.appending || this.queue.length === 0 || !this.sourceBuffer ||
        !this.mediaSource || this.mediaSource.readyState !== 'open' || this.sourceBuffer.updating) return
    this.appending = true
    const chunk = this.queue.shift()!
    try {
      this.sourceBuffer.appendBuffer(chunk)
    } catch (e: unknown) {
      this.appending = false
      if (e instanceof DOMException && e.name === 'QuotaExceededError') { this.trimBuffer(true) }
    }
  }

  private tryPlay(): void {
    if (!this.audioElement || !this.sourceBuffer) return
    if (this.audioElement.paused && this.sourceBuffer.buffered.length > 0) {
      this.audioElement.play().then(() => { runInAction(() => { this.isPlaying = true }) }).catch(() => {})
    }
    if (this.sourceBuffer.buffered.length > 0) {
      const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1)
      if (end - this.audioElement.currentTime > 3) { this.audioElement.currentTime = end - 0.5 }
    }
  }

  private trimBuffer(force = false): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.sourceBuffer.buffered.length === 0) return
    const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1)
    const start = this.sourceBuffer.buffered.start(0)
    const maxDuration = force ? 5 : 10
    if (end - start > maxDuration) { try { this.sourceBuffer.remove(start, end - 5) } catch { /* ignore */ } }
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.disposed) { this.setupMediaSource(url, 'audio/webm; codecs=opus') }
    }, this.reconnectInterval)
  }

  private cleanup(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.websocket) { this.websocket.onclose = null; this.websocket.close(); this.websocket = null }
    if (this.mediaSource?.readyState === 'open') { try { this.mediaSource.endOfStream() } catch { /* ignore */ } }
    if (this.audioElement) { this.audioElement.pause(); this.audioElement.src = ''; this.audioElement = null }
    this.mediaSource = null; this.sourceBuffer = null; this.queue = []; this.appending = false
    runInAction(() => { this.isConnected = false; this.isPlaying = false })
  }
}
