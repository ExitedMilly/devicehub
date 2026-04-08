import { makeAutoObservable, runInAction } from 'mobx'
import { inject, injectable } from 'inversify'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceConnectionRequired } from '@/config/inversify/decorators'

export type EmulatorMicState = 'listening' | 'idle' | 'unknown'

@injectable()
@deviceConnectionRequired()
export class DeviceMicStore {
  private signalingWs: WebSocket | null = null
  private peerConnection: RTCPeerConnection | null = null
  private mediaStream: MediaStream | null = null
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
              if (this.autoStopTimer) {
                clearTimeout(this.autoStopTimer)
                this.autoStopTimer = null
              }
            }

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

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      const audioTrack = this.mediaStream.getAudioTracks()[0]
      if (audioTrack) {
        const settings = audioTrack.getSettings()
        const constraints = audioTrack.getConstraints()
        const capabilities =
          typeof audioTrack.getCapabilities === 'function'
            ? audioTrack.getCapabilities()
            : null

        console.log('[DeviceMicStore] Audio track settings:', settings)
        console.log('[DeviceMicStore] Audio track constraints:', constraints)
        console.log('[DeviceMicStore] Audio track capabilities:', capabilities)
      }
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

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const micUrl = `${wsProto}//${window.location.host}/mic-rtc/${device.serial}`
    this.connectSignaling(micUrl)
  }

  stopMic(): void {
    this.disposed = true
    this.cleanup()
  }

  private connectSignaling(url: string): void {
    if (this.disposed) return

    this.signalingWs = new WebSocket(url)

    this.signalingWs.onopen = (): void => {
      if (this.disposed || !this.mediaStream) {
        this.cleanup()
        return
      }

      console.log('[DeviceMicStore] Signaling WS connected, starting WebRTC mic')
      runInAction(() => {
        this.isConnected = true
        this.isActive = true
      })

      this.startWebRTC()
    }

    this.signalingWs.onmessage = (event: MessageEvent): void => {
      try {
        const msg = JSON.parse(event.data as string)
        void this.handleSignalingMessage(msg)
      } catch (err) {
        console.error('[DeviceMicStore] Signaling parse error:', err)
      }
    }

    this.signalingWs.onerror = (): void => {
      console.error('[DeviceMicStore] Signaling WS error')
    }

    this.signalingWs.onclose = (): void => {
      runInAction(() => {
        this.isConnected = false
      })

      if (!this.disposed) {
        this.cleanup()
      }
    }
  }

  private async startWebRTC(): Promise<void> {
    if (!this.mediaStream || !this.signalingWs) return

    this.pendingCandidates = []
    this.remoteDescriptionSet = false

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    })

    const audioTrack = this.mediaStream.getAudioTracks()[0]
    if (!audioTrack) {
      console.error('[DeviceMicStore] No audio track in mediaStream')
      this.cleanup()
      return
    }

    this.peerConnection.addTrack(audioTrack, this.mediaStream)

    this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
      const cand = event.candidate?.candidate ?? ''
      if (!event.candidate || !cand.trim()) {
        console.log('[DeviceMicStore] Local ICE gathering complete')
        return
      }
      console.log('[DeviceMicStore] Local ICE candidate:', cand)
      if (this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        }))
      }
    }

    this.peerConnection.onconnectionstatechange = (): void => {
      const state = this.peerConnection?.connectionState
      console.log('[DeviceMicStore] Connection state:', state)
      if (state === 'failed') {
        console.log('[DeviceMicStore] ICE failed, auto-reconnecting...')
        this.reconnectWebRTC()
      }
    }

    try {
      const offer = await this.peerConnection.createOffer()
      await this.peerConnection.setLocalDescription(offer)
      if (this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }))
        console.log('[DeviceMicStore] Sent SDP offer')
      }
    } catch (err) {
      console.error('[DeviceMicStore] Failed to create offer:', err)
      runInAction(() => {
        this.errorMessage = 'WebRTC offer creation failed'
      })
      this.cleanup()
    }
  }

  private async handleSignalingMessage(msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }): Promise<void> {
    if (!this.peerConnection) return

    try {
      if (msg.type === 'answer' && msg.sdp) {
        console.log('[DeviceMicStore] Received SDP answer')
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
        this.remoteDescriptionSet = true
        if (this.pendingCandidates.length > 0) {
          console.log('[DeviceMicStore] Flushing ' + this.pendingCandidates.length + ' buffered ICE candidates')
          for (const candidate of this.pendingCandidates) {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          }
          this.pendingCandidates = []
        }
      } else if (msg.type === 'candidate' && msg.candidate) {
        const cand = msg.candidate.candidate ?? ''
        if (!cand.trim()) return
        console.log('[DeviceMicStore] Remote ICE candidate:', cand)
        if (this.remoteDescriptionSet) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } else {
          this.pendingCandidates.push(msg.candidate)
        }
      }
    } catch (err) {
      console.error('[DeviceMicStore] Signaling handling error:', err)
    }
  }

  private releaseMediaStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop()
      }

      this.mediaStream = null
    }
  }

  private reconnectWebRTC(): void {
    if (this.disposed || !this.signalingWs || this.signalingWs.readyState !== WebSocket.OPEN) return
    if (!this.mediaStream || this.mediaStream.getAudioTracks().length === 0) return

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null
      this.peerConnection.onconnectionstatechange = null
      try { this.peerConnection.close() } catch {
        // Ignore
      }
      this.peerConnection = null
    }

    this.pendingCandidates = []
    this.remoteDescriptionSet = false

    setTimeout(() => {
      if (this.disposed || !this.signalingWs || this.signalingWs.readyState !== WebSocket.OPEN) return
      console.log('[DeviceMicStore] Reconnecting WebRTC...')
      void this.startWebRTC()
    }, 1000)
  }

  private cleanup(): void {
    this.pendingCandidates = []
    this.remoteDescriptionSet = false

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null
      this.peerConnection.onconnectionstatechange = null
      try {
        this.peerConnection.close()
      } catch {
        // Ignore
      }
      this.peerConnection = null
    }

    this.releaseMediaStream()

    if (this.signalingWs) {
      this.signalingWs.onclose = null
      this.signalingWs.close()
      this.signalingWs = null
    }

    runInAction(() => {
      this.isActive = false
      this.isConnected = false
    })
  }
}
