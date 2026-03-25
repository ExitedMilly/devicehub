import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

export type EmulatorCameraState = 'active' | 'inactive' | 'unknown'

// Must match v4l2loopback device size exactly — no server-side rescale
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 480
const TARGET_FPS = 10
const JPEG_QUALITY = 0.3

@injectable()
@deviceConnectionRequired()
export class DeviceCameraStore {
  private websocket: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private disposed = false
  private stateDisposed = false
  private stateWs: WebSocket | null = null
  private stateWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private captureInterval: ReturnType<typeof setInterval> | null = null
  private videoElement: HTMLVideoElement | null = null
  private canvasElement: HTMLCanvasElement | null = null
  private canvasCtx: CanvasRenderingContext2D | null = null

  isActive = false
  isConnected = false
  errorMessage: string | null = null
  emulatorCameraState: EmulatorCameraState = 'unknown'
  isStateConnected = false

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {
    makeAutoObservable(this)
  }

  get canActivateCamera(): boolean {
    return this.emulatorCameraState === 'active'
  }

  async subscribeToCameraState(): Promise<void> {
    if (this.stateWs) return
    this.stateDisposed = false
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    this.connectStateWs(device.serial)
  }

  unsubscribeFromCameraState(): void {
    this.stateDisposed = true
    if (this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null }
    if (this.stateWsReconnectTimer) { clearTimeout(this.stateWsReconnectTimer); this.stateWsReconnectTimer = null }
    if (this.stateWs) { this.stateWs.onclose = null; this.stateWs.close(); this.stateWs = null }
    runInAction(() => { this.isStateConnected = false; this.emulatorCameraState = 'unknown' })
  }

  private connectStateWs(serial: string): void {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.stateWs = new WebSocket(`${wsProto}//${window.location.host}/camera-state/${serial}`)

    this.stateWs.onopen = (): void => {
      runInAction(() => { this.isStateConnected = true })
    }

    this.stateWs.onmessage = (event: MessageEvent): void => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'camera_state') {
          const newState = msg.state as EmulatorCameraState
          runInAction(() => {
            this.emulatorCameraState = newState
            if (newState === 'active' && this.autoStopTimer) {
              clearTimeout(this.autoStopTimer)
              this.autoStopTimer = null
            }
            if (newState === 'inactive' && this.isActive) {
              if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
              this.autoStopTimer = setTimeout(() => {
                this.autoStopTimer = null
                if (this.isActive && this.emulatorCameraState === 'inactive') {
                  this.stopCamera()
                }
              }, 1500)
            }
          })
        }
      } catch { /* ignore */ }
    }

    this.stateWs.onerror = (): void => {}
    this.stateWs.onclose = (): void => {
      runInAction(() => { this.isStateConnected = false })
      this.stateWsReconnectTimer = setTimeout(() => {
        this.stateWsReconnectTimer = null
        if (!this.stateDisposed) { this.connectStateWs(serial) }
      }, 3000)
    }
  }

  async startCamera(): Promise<void> {
    if (this.isActive) return
    this.disposed = false
    this.errorMessage = null
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: FRAME_WIDTH }, height: { ideal: FRAME_HEIGHT }, frameRate: { ideal: TARGET_FPS } },
      })
    } catch (err) {
      runInAction(() => { this.errorMessage = 'Camera access denied' })
      return
    }

    if (this.disposed) { this.releaseMediaStream(); return }

    this.videoElement = document.createElement('video')
    this.videoElement.srcObject = this.mediaStream
    this.videoElement.muted = true
    this.videoElement.playsInline = true
    await this.videoElement.play()

    this.canvasElement = document.createElement('canvas')
    this.canvasElement.width = FRAME_WIDTH
    this.canvasElement.height = FRAME_HEIGHT
    this.canvasCtx = this.canvasElement.getContext('2d')

    if (this.disposed) { this.cleanup(); return }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.connectDataWs(`${wsProto}//${window.location.host}/camera/${device.serial}`)
  }

  stopCamera(): void {
    this.disposed = true
    this.cleanup()
  }

  private connectDataWs(url: string): void {
    if (this.disposed) return
    this.websocket = new WebSocket(url)
    this.websocket.binaryType = 'arraybuffer'

    this.websocket.onopen = (): void => {
      if (this.disposed || !this.mediaStream) { this.cleanup(); return }
      runInAction(() => { this.isConnected = true; this.isActive = true })
      this.startCapture()
    }

    this.websocket.onerror = (): void => {}
    this.websocket.onclose = (): void => {
      runInAction(() => { this.isConnected = false })
      if (!this.disposed) { this.cleanup() }
    }
  }

  private startCapture(): void {
    if (!this.videoElement || !this.canvasCtx || !this.websocket) return

    this.captureInterval = setInterval(() => {
      if (this.disposed || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) return
      if (this.websocket.bufferedAmount > 20000) return

      this.canvasCtx!.drawImage(this.videoElement!, 0, 0, FRAME_WIDTH, FRAME_HEIGHT)
      this.canvasElement!.toBlob(
        (blob) => {
          if (!blob || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) return
          if (this.websocket.bufferedAmount > 20000) return
          blob.arrayBuffer().then((buf) => {
            if (this.websocket?.readyState === WebSocket.OPEN && this.websocket.bufferedAmount < 20000) {
              this.websocket.send(buf)
            }
          })
        },
        'image/jpeg',
        JPEG_QUALITY
      )
    }, 1000 / TARGET_FPS)
  }

  private releaseMediaStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) { track.stop() }
      this.mediaStream = null
    }
  }

  private cleanup(): void {
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null }
    if (this.videoElement) { this.videoElement.pause(); this.videoElement.srcObject = null; this.videoElement = null }
    this.canvasElement = null
    this.canvasCtx = null
    this.releaseMediaStream()
    if (this.websocket) { this.websocket.onclose = null; this.websocket.close(); this.websocket = null }
    runInAction(() => { this.isActive = false; this.isConnected = false })
  }
}
