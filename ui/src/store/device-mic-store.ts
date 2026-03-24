import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

export type EmulatorMicState = 'listening' | 'idle' | 'unknown'

@injectable()
@deviceConnectionRequired()
export class DeviceMicStore {
  private websocket: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private disposed = false
  private stateDisposed = false
  private stateWs: WebSocket | null = null
  private stateWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null

  isActive = false
  isConnected = false
  errorMessage: string | null = null

  /** Current emulator mic state: is Android listening for microphone input? */
  emulatorMicState: EmulatorMicState = 'unknown'

  /** Whether the emulator mic state subscription is connected */
  isStateConnected = false

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  /** Whether the mic button should be enabled (Android is actively listening) */
  get canActivateMic(): boolean {
    return this.emulatorMicState === 'listening'
  }

  /** Subscribe to emulator mic state changes. Call once when device page opens. */
  async subscribeToMicState(): Promise<void> {
    if (this.stateWs) return

    this.stateDisposed = false
    const device = await this.deviceBySerialStore.fetch()

    if (!device?.serial) return

    this.connectStateWs(device.serial)
  }

  /** Unsubscribe from emulator mic state. Call when leaving device page. */
  unsubscribeFromMicState(): void {
    this.stateDisposed = true

    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }

    if (this.stateWsReconnectTimer) {
      clearTimeout(this.stateWsReconnectTimer)
      this.stateWsReconnectTimer = null
    }

    if (this.stateWs) {
      this.stateWs.onclose = null
      this.stateWs.close()
      this.stateWs = null
    }

    runInAction(() => {
      this.isStateConnected = false
      this.emulatorMicState = 'unknown'
    })
  }

  private connectStateWs(serial: string): void {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${wsProto}//${window.location.host}/mic-state/${serial}`

    this.stateWs = new WebSocket(url)

    this.stateWs.onopen = (): void => {
      runInAction(() => {
        this.isStateConnected = true
      })

      console.log('[DeviceMicStore] Mic state WS connected for', serial)
    }

    this.stateWs.onmessage = (event: MessageEvent): void => {
      try {
        const msg = JSON.parse(event.data as string)

        if (msg.type === 'mic_state') {
          const newState = msg.state as EmulatorMicState

          runInAction(() => {
            this.emulatorMicState = newState

            if (newState === 'listening') {
              // Cancel pending auto-stop — emulator is listening again
              if (this.autoStopTimer) {
                clearTimeout(this.autoStopTimer)
                this.autoStopTimer = null
              }
            }

            // Auto-stop mic when emulator stops listening (with 3s grace period)
            if (newState === 'idle' && this.isActive) {
              if (this.autoStopTimer) clearTimeout(this.autoStopTimer)

              this.autoStopTimer = setTimeout(() => {
                this.autoStopTimer = null

                if (this.isActive && this.emulatorMicState === 'idle') {
                  console.log('[DeviceMicStore] Emulator stopped listening, auto-stopping mic')
                  this.stopMic()
                }
              }, 3000)
            }
          })
        }
      } catch {
        // Ignore parse errors
      }
    }

    this.stateWs.onerror = (): void => {
      console.error('[DeviceMicStore] Mic state WS error')
    }

    this.stateWs.onclose = (): void => {
      runInAction(() => {
        this.isStateConnected = false
      })

      // Auto-reconnect after 3 seconds
      this.stateWsReconnectTimer = setTimeout(() => {
        this.stateWsReconnectTimer = null

        if (!this.stateDisposed) {
          console.log('[DeviceMicStore] Reconnecting mic state WS...')
          this.connectStateWs(serial)
        }
      }, 3000)
    }
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
