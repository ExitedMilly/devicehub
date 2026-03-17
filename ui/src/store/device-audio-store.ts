import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

// WebM Cluster element ID — used to detect init segment boundary

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
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  async startAudioStreaming(): Promise<void> {
    this.disposed = false
    const device = await this.deviceBySerialStore.fetch()

    if (!device?.serial) {
      console.warn('[DeviceAudioStore] No device serial')
      return
    }

    // Check MSE support
    const mimeType = 'audio/webm; codecs=opus'

    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
      console.warn('[DeviceAudioStore] MediaSource not supported for', mimeType)
      return
    }

    runInAction(() => {
      this.hasAudio = true
    })

    // Construct audio WS URL from device serial
    const audioUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/audio/${device.serial}`

    this.setupMediaSource(audioUrl, mimeType)
  }

  stopAudioStreaming(): void {
    this.disposed = true
    this.cleanup()
  }

  toggleMute(): void {
    this.isMuted = !this.isMuted

    if (this.audioElement) {
      this.audioElement.muted = this.isMuted
    }
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))

    if (this.audioElement) {
      this.audioElement.volume = this.volume
    }
  }

  private setupMediaSource(audioUrl: string, mimeType: string): void {
    this.cleanup()

    this.audioElement = document.createElement('audio')
    this.audioElement.volume = this.volume
    this.audioElement.muted = this.isMuted

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

        this.sourceBuffer.addEventListener('error', () => {
          console.error('[DeviceAudioStore] SourceBuffer error')
        })

        // Connect WebSocket after SourceBuffer is ready
        this.connectWebSocket(audioUrl)
      } catch (e) {
        console.error('[DeviceAudioStore] Failed to create SourceBuffer:', e)
      }
    })
  }

  private connectWebSocket(url: string): void {
    if (this.disposed) return

    this.websocket = new WebSocket(url)
    this.websocket.binaryType = 'arraybuffer'

    this.websocket.onopen = () => {
      runInAction(() => {
        this.isConnected = true
        this.reconnectAttempt = 0
      })
    }

    this.websocket.onmessage = (event: MessageEvent) => {
      this.queue.push(new Uint8Array(event.data))
      this.drainQueue()
    }

    this.websocket.onerror = () => {
      console.error('[DeviceAudioStore] WebSocket error')
    }

    this.websocket.onclose = () => {
      runInAction(() => {
        this.isConnected = false
        this.isPlaying = false
      })

      if (!this.disposed) {
        this.scheduleReconnect(url)
      }
    }
  }

  private drainQueue(): void {
    if (
      this.appending ||
      this.queue.length === 0 ||
      !this.sourceBuffer ||
      !this.mediaSource ||
      this.mediaSource.readyState !== 'open' ||
      this.sourceBuffer.updating
    ) {
      return
    }

    this.appending = true
    const chunk = this.queue.shift()!

    try {
      this.sourceBuffer.appendBuffer(chunk)
    } catch (e: unknown) {
      this.appending = false

      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        this.trimBuffer(true)
      } else {
        console.error('[DeviceAudioStore] Append error:', e)
      }
    }
  }

  private tryPlay(): void {
    if (!this.audioElement || !this.sourceBuffer) return

    if (this.audioElement.paused && this.sourceBuffer.buffered.length > 0) {
      this.audioElement.play()
        .then(() => {
          runInAction(() => {
            this.isPlaying = true
          })
        })
        .catch(() => {
          // Autoplay blocked — user needs to interact first
        })
    }

    // Stay near live edge
    if (this.sourceBuffer.buffered.length > 0) {
      const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1)
      const lag = end - this.audioElement.currentTime

      if (lag > 3) {
        this.audioElement.currentTime = end - 0.5
      }
    }
  }

  private trimBuffer(force = false): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.sourceBuffer.buffered.length === 0) return

    const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1)
    const start = this.sourceBuffer.buffered.start(0)
    const duration = end - start

    // Keep max 10 seconds of buffer (or 5 when forced)
    const maxDuration = force ? 5 : 10

    if (duration > maxDuration) {
      try {
        this.sourceBuffer.remove(start, end - 5)
      } catch {
        // Ignore — may be updating
      }
    }
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      console.warn('[DeviceAudioStore] Max reconnect attempts reached')
      return
    }

    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null

      if (!this.disposed) {
        // Need fresh MediaSource for new connection
        this.setupMediaSource(url, 'audio/webm; codecs=opus')
      }
    }, this.reconnectInterval)
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.websocket) {
      this.websocket.onclose = null // Prevent reconnect on intentional close
      this.websocket.close()
      this.websocket = null
    }

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream()
      } catch {
        // Ignore
      }
    }

    if (this.audioElement) {
      this.audioElement.pause()
      this.audioElement.src = ''
      this.audioElement = null
    }

    this.mediaSource = null
    this.sourceBuffer = null
    this.queue = []
    this.appending = false

    runInAction(() => {
      this.isConnected = false
      this.isPlaying = false
    })
  }
}
