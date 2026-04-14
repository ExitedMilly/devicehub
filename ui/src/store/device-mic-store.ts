import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { DeviceMediaDevicesStore } from '@/store/device-media-devices-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

export type EmulatorMicState = 'listening' | 'idle' | 'unknown'

@injectable()
@deviceConnectionRequired()
export class DeviceMicStore {
  private signalingWs: WebSocket | null = null
  private peerConnection: RTCPeerConnection | null = null
  private mediaStream: MediaStream | null = null
  private audioSender: RTCRtpSender | null = null
  private disposed = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private stateDisposed = false
  private stateWs: WebSocket | null = null
  private stateWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null

  isActive = false
  isConnected = false
  errorMessage: string | null = null
  emulatorMicState: EmulatorMicState = 'unknown'
  isStateConnected = false

  constructor(
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore,
    @inject(CONTAINER_IDS.deviceMediaDevicesStore) private mediaDevicesStore: DeviceMediaDevicesStore
  ) {
    makeAutoObservable(this)
  }

  get canActivateMic(): boolean {
    return this.emulatorMicState === 'listening'
  }

  async subscribeToMicState(): Promise<void> {
    if (this.stateWs) return
    this.stateDisposed = false
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return
    this.connectStateWs(device.serial)
  }

  unsubscribeFromMicState(): void {
    this.stateDisposed = true
    if (this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null }
    if (this.stateWsReconnectTimer) { clearTimeout(this.stateWsReconnectTimer); this.stateWsReconnectTimer = null }
    if (this.stateWs) { this.stateWs.onclose = null; this.stateWs.close(); this.stateWs = null }
    runInAction(() => { this.isStateConnected = false; this.emulatorMicState = 'unknown' })
  }

  private connectStateWs(serial: string): void {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.stateWs = new WebSocket(`${wsProto}//${window.location.host}/mic-state/${serial}`)
    this.stateWs.onopen = (): void => {
      runInAction(() => { this.isStateConnected = true })
      console.log('[DeviceMicStore] Mic state WS connected for', serial)
    }
    this.stateWs.onmessage = (event: MessageEvent): void => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'mic_state') {
          const newState = msg.state as EmulatorMicState
          runInAction(() => {
            this.emulatorMicState = newState
            if (newState === 'listening' && this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null }
            if (newState === 'idle' && this.isActive) {
              if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
              this.autoStopTimer = setTimeout(() => {
                this.autoStopTimer = null
                if (this.isActive && this.emulatorMicState === 'idle') { this.stopMic() }
              }, 3000)
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
        if (!this.stateDisposed) { console.log('[DeviceMicStore] Reconnecting mic state WS...'); this.connectStateWs(serial) }
      }, 3000)
    }
  }

  async startMic(deviceId?: string): Promise<void> {
    if (this.isActive) return
    this.disposed = false
    this.errorMessage = null
    const device = await this.deviceBySerialStore.fetch()
    if (!device?.serial) return

    const requestedMicId = deviceId ?? this.mediaDevicesStore.selectedMicId
    const micId = requestedMicId && this.mediaDevicesStore.microphones.some(device => device.deviceId === requestedMicId)
      ? requestedMicId
      : undefined
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micId ? { deviceId: { exact: micId } } : {}),
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      void this.mediaDevicesStore.refreshDevices()
      const actualId = this.mediaStream.getAudioTracks()[0]?.getSettings().deviceId
      if (actualId) this.mediaDevicesStore.selectMic(actualId)
      else if (micId) this.mediaDevicesStore.selectMic(micId)
    } catch (err) {
      runInAction(() => { this.errorMessage = 'Microphone access denied' })
      return
    }
    if (this.disposed) { this.releaseMediaStream(); return }

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.connectSignaling(`${wsProto}//${window.location.host}/mic-rtc/${device.serial}`)
  }

  /** Select microphone before start or switch microphone on the fly via replaceTrack */
  async switchMic(deviceId: string): Promise<void> {
    this.mediaDevicesStore.selectMic(deviceId)

    if (!this.audioSender || !this.isActive) return
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      })
      const newTrack = newStream.getAudioTracks()[0]
      if (!newTrack) return
      await this.audioSender.replaceTrack(newTrack)
      if (this.mediaStream) { for (const t of this.mediaStream.getAudioTracks()) { t.stop() } }
      this.mediaStream = newStream
      this.mediaDevicesStore.selectMic(deviceId)
      console.log('[DeviceMicStore] Switched mic to:', deviceId)
    } catch (err) {
      console.error('[DeviceMicStore] Failed to switch mic:', err)
    }
  }

  stopMic(): void { this.disposed = true; this.cleanup() }

  private connectSignaling(url: string): void {
    if (this.disposed) return
    this.signalingWs = new WebSocket(url)
    this.signalingWs.onopen = (): void => {
      if (this.disposed || !this.mediaStream) { this.cleanup(); return }
      console.log('[DeviceMicStore] Signaling WS connected, starting WebRTC mic')
      runInAction(() => { this.isConnected = true; this.isActive = true })
      this.startWebRTC()
    }
    this.signalingWs.onmessage = (event: MessageEvent): void => {
      try { void this.handleSignalingMessage(JSON.parse(event.data as string)) } catch { /* ignore */ }
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
    const audioTrack = this.mediaStream.getAudioTracks()[0]
    if (!audioTrack) { this.cleanup(); return }
    this.audioSender = this.peerConnection.addTrack(audioTrack, this.mediaStream)
    this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate?.candidate?.trim()) return
      if (this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'candidate', candidate: event.candidate.toJSON() }))
      }
    }
    this.peerConnection.onconnectionstatechange = (): void => {
      const state = this.peerConnection?.connectionState
      console.log('[DeviceMicStore] Connection state:', state)
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
    } catch (err) { console.error('[DeviceMicStore] Signaling error:', err) }
  }

  private releaseMediaStream(): void {
    if (this.mediaStream) { for (const t of this.mediaStream.getTracks()) { t.stop() }; this.mediaStream = null }
  }

  private reconnectWebRTC(): void {
    if (this.disposed || !this.signalingWs || this.signalingWs.readyState !== WebSocket.OPEN) return
    if (!this.mediaStream?.getAudioTracks().length) return
    if (this.peerConnection) { try { this.peerConnection.close() } catch {}; this.peerConnection = null }
    this.audioSender = null; this.pendingCandidates = []; this.remoteDescriptionSet = false
    setTimeout(() => { if (!this.disposed && this.signalingWs?.readyState === WebSocket.OPEN) void this.startWebRTC() }, 1000)
  }

  private cleanup(): void {
    this.pendingCandidates = []; this.remoteDescriptionSet = false; this.audioSender = null
    if (this.peerConnection) { try { this.peerConnection.close() } catch {}; this.peerConnection = null }
    this.releaseMediaStream()
    if (this.signalingWs) { this.signalingWs.onclose = null; this.signalingWs.close(); this.signalingWs = null }
    runInAction(() => { this.isActive = false; this.isConnected = false })
  }
}
