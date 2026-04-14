import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { DeviceMediaDevicesStore } from '@/store/device-media-devices-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

export type EmulatorCameraState = 'active' | 'inactive' | 'unknown'

@injectable()
@deviceConnectionRequired()
export class DeviceCameraStore {
  private signalingWs: WebSocket | null = null
  private peerConnection: RTCPeerConnection | null = null
  private mediaStream: MediaStream | null = null
  private videoSender: RTCRtpSender | null = null
  private disposed = false
  private stateDisposed = false
  private stateWs: WebSocket | null = null
  private stateWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false

  isActive = false
  isConnected = false
  errorMessage: string | null = null
  emulatorCameraState: EmulatorCameraState = 'unknown'
  isStateConnected = false

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore,
    @inject(CONTAINER_IDS.deviceMediaDevicesStore) private mediaDevicesStore: DeviceMediaDevicesStore
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
    this.stateWs.onopen = (): void => { runInAction(() => { this.isStateConnected = true }) }
    this.stateWs.onmessage = (event: MessageEvent): void => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'camera_state') {
          const newState = msg.state as EmulatorCameraState
          runInAction(() => {
            this.emulatorCameraState = newState
            if (newState === 'active' && this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null }
            if (newState === 'inactive' && this.isActive) {
              if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
              this.autoStopTimer = setTimeout(() => {
                this.autoStopTimer = null
                if (this.isActive && this.emulatorCameraState === 'inactive') { this.stopCamera() }
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

  async startCamera(deviceId?: string): Promise<void> {
    if (this.isActive) return
    this.disposed = false
    this.errorMessage = null
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    const requestedCameraId = deviceId ?? this.mediaDevicesStore.selectedCameraId
    const cameraId = requestedCameraId && this.mediaDevicesStore.cameras.some(device => device.deviceId === requestedCameraId)
      ? requestedCameraId
      : undefined
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
          width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 25 },
        },
      })
      void this.mediaDevicesStore.refreshDevices()
      const actualId = this.mediaStream.getVideoTracks()[0]?.getSettings().deviceId
      if (actualId) this.mediaDevicesStore.selectCamera(actualId)
      else if (cameraId) this.mediaDevicesStore.selectCamera(cameraId)
    } catch (err) {
      runInAction(() => { this.errorMessage = 'Camera access denied' })
      return
    }
    if (this.disposed) { this.releaseMediaStream(); return }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.connectSignaling(`${wsProto}//${window.location.host}/camera/${device.serial}`)
  }

  /** Select camera before start or switch camera on the fly via replaceTrack */
  async switchCamera(deviceId: string): Promise<void> {
    this.mediaDevicesStore.selectCamera(deviceId)

    if (!this.videoSender || !this.isActive) return
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 25 } },
      })
      const newTrack = newStream.getVideoTracks()[0]
      if (!newTrack) return
      await this.videoSender.replaceTrack(newTrack)
      if (this.mediaStream) { for (const t of this.mediaStream.getVideoTracks()) { t.stop() } }
      this.mediaStream = newStream
      this.mediaDevicesStore.selectCamera(deviceId)
      console.log('[DeviceCameraStore] Switched camera to:', deviceId)
    } catch (err) {
      console.error('[DeviceCameraStore] Failed to switch camera:', err)
    }
  }

  stopCamera(): void { this.disposed = true; this.cleanup() }

  private connectSignaling(url: string): void {
    if (this.disposed) return
    this.signalingWs = new WebSocket(url)
    this.signalingWs.onopen = (): void => {
      if (this.disposed || !this.mediaStream) { this.cleanup(); return }
      runInAction(() => { this.isConnected = true; this.isActive = true })
      this.startWebRTC()
    }
    this.signalingWs.onmessage = (event: MessageEvent): void => {
      try { this.handleSignalingMessage(JSON.parse(event.data as string)) } catch { /* ignore */ }
    }
    this.signalingWs.onerror = (): void => {}
    this.signalingWs.onclose = (): void => {
      runInAction(() => { this.isConnected = false })
      if (!this.disposed) { this.cleanup() }
    }
  }

  private async startWebRTC(): Promise<void> {
    if (!this.mediaStream || !this.signalingWs) return
    this.pendingCandidates = []; this.remoteDescriptionSet = false
    this.peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
    const videoTrack = this.mediaStream.getVideoTracks()[0]
    if (!videoTrack) { this.cleanup(); return }
    this.videoSender = this.peerConnection.addTrack(videoTrack, this.mediaStream)
    this.preferH264Codec(this.videoSender)
    this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate?.candidate?.trim()) return
      if (this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'candidate', candidate: event.candidate.toJSON() }))
      }
    }
    this.peerConnection.onconnectionstatechange = (): void => {
      const state = this.peerConnection?.connectionState
      console.log('[DeviceCameraStore] Connection state:', state)
      if (state === 'failed') { this.reconnectWebRTC() }
    }
    try {
      const offer = await this.peerConnection.createOffer()
      await this.peerConnection.setLocalDescription(offer)
      if (this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }))
      }
    } catch (err) {
      runInAction(() => { this.errorMessage = 'WebRTC offer creation failed' })
      this.cleanup()
    }
  }

  private async handleSignalingMessage(msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }): Promise<void> {
    if (!this.peerConnection) return
    try {
      if (msg.type === 'answer' && msg.sdp) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
        this.remoteDescriptionSet = true
        for (const c of this.pendingCandidates) { await this.peerConnection.addIceCandidate(new RTCIceCandidate(c)) }
        this.pendingCandidates = []
      } else if (msg.type === 'candidate' && msg.candidate?.candidate?.trim()) {
        if (this.remoteDescriptionSet) { await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)) }
        else { this.pendingCandidates.push(msg.candidate) }
      }
    } catch (err) { console.error('[DeviceCameraStore] Signaling error:', err) }
  }

  private preferH264Codec(sender: RTCRtpSender): void {
    if (!this.peerConnection) return
    const t = this.peerConnection.getTransceivers().find(t => t.sender === sender)
    if (!t || typeof t.setCodecPreferences !== 'function') return
    try {
      const caps = RTCRtpSender.getCapabilities?.('video')
      if (!caps) return
      const h264 = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264')
      const vp8 = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/vp8')
      const rest = caps.codecs.filter(c => !['video/h264', 'video/vp8'].includes(c.mimeType.toLowerCase()))
      if (h264.length) t.setCodecPreferences([...h264, ...vp8, ...rest])
    } catch { /* ignore */ }
  }

  private releaseMediaStream(): void {
    if (this.mediaStream) { for (const t of this.mediaStream.getTracks()) { t.stop() }; this.mediaStream = null }
  }

  private reconnectWebRTC(): void {
    if (this.disposed || !this.signalingWs || this.signalingWs.readyState !== WebSocket.OPEN) return
    if (!this.mediaStream?.getVideoTracks().length) return
    if (this.peerConnection) { try { this.peerConnection.close() } catch {} ; this.peerConnection = null }
    this.videoSender = null; this.pendingCandidates = []; this.remoteDescriptionSet = false
    setTimeout(() => { if (!this.disposed && this.signalingWs?.readyState === WebSocket.OPEN) this.startWebRTC() }, 1000)
  }

  private cleanup(): void {
    this.pendingCandidates = []; this.remoteDescriptionSet = false; this.videoSender = null
    if (this.peerConnection) { try { this.peerConnection.close() } catch {}; this.peerConnection = null }
    this.releaseMediaStream()
    if (this.signalingWs) { this.signalingWs.onclose = null; this.signalingWs.close(); this.signalingWs = null }
    runInAction(() => { this.isActive = false; this.isConnected = false })
  }
}
