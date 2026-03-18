import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

@injectable()
@deviceConnectionRequired()
export class DeviceMicStore {
  private websocket: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private disposed = false

  isActive = false
  isConnected = false
  errorMessage: string | null = null

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  async startMic(): Promise<void> {
    if (this.isActive) return

    this.disposed = false
    this.errorMessage = null
    const device = await this.deviceBySerialStore.fetch()

    if (!device?.serial) {
      console.warn('[DeviceMicStore] No device serial')
      return
    }

    // Request microphone access
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      runInAction(() => {
        this.errorMessage = 'Microphone access denied'
      })
      console.error('[DeviceMicStore] getUserMedia failed:', err)
      return
    }

    if (this.disposed) {
      this.releaseMediaStream()
      return
    }

    // Check MediaRecorder support for webm/opus
    const mimeType = 'audio/webm;codecs=opus'

    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn('[DeviceMicStore] MediaRecorder does not support', mimeType)
      this.releaseMediaStream()

      runInAction(() => {
        this.errorMessage = 'Browser does not support audio/webm;codecs=opus'
      })

      return
    }

    // Connect WebSocket
    const micUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/mic/${device.serial}`

    this.connectWebSocket(micUrl, mimeType)
  }

  stopMic(): void {
    this.disposed = true
    this.cleanup()
  }

  private connectWebSocket(url: string, mimeType: string): void {
    if (this.disposed) return

    this.websocket = new WebSocket(url)
    this.websocket.binaryType = 'arraybuffer'

    this.websocket.onopen = (): void => {
      if (this.disposed || !this.mediaStream) {
        this.cleanup()
        return
      }

      runInAction(() => {
        this.isConnected = true
        this.isActive = true
      })

      this.startRecording(mimeType)
    }

    this.websocket.onerror = (): void => {
      console.error('[DeviceMicStore] WebSocket error')
    }

    this.websocket.onclose = (): void => {
      runInAction(() => {
        this.isConnected = false
      })

      // If not intentionally stopped, clean up
      if (!this.disposed) {
        this.cleanup()
      }
    }
  }

  private startRecording(mimeType: string): void {
    if (!this.mediaStream || !this.websocket) return

    try {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType,
        audioBitsPerSecond: 64000,
      })
    } catch (err) {
      console.error('[DeviceMicStore] Failed to create MediaRecorder:', err)
      this.cleanup()
      return
    }

    this.mediaRecorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data.size > 0 && this.websocket?.readyState === WebSocket.OPEN) {
        event.data.arrayBuffer().then((buffer) => {
          if (this.websocket?.readyState === WebSocket.OPEN) {
            this.websocket.send(buffer)
          }
        })
      }
    }

    this.mediaRecorder.onerror = (): void => {
      console.error('[DeviceMicStore] MediaRecorder error')
      this.cleanup()
    }

    // Send chunks every 100ms for low latency
    this.mediaRecorder.start(100)
    console.log('[DeviceMicStore] Recording started')
  }

  private releaseMediaStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop()
      }

      this.mediaStream = null
    }
  }

  private cleanup(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop()
      } catch {
        // Ignore
      }
    }

    this.mediaRecorder = null

    this.releaseMediaStream()

    if (this.websocket) {
      this.websocket.onclose = null
      this.websocket.close()
      this.websocket = null
    }

    runInAction(() => {
      this.isActive = false
      this.isConnected = false
    })
  }
}
