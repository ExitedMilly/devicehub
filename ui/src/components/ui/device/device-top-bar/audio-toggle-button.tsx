import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'
import { Icon24VolumeOutline, Icon24MuteOutline } from '@vkontakte/icons'

import { DeviceSelector } from './device-selector'
import { CONTAINER_IDS } from '@/config/inversify/container-ids'

export const AudioToggleButton = observer(() => {
  const deviceAudioStore = useInjection(CONTAINER_IDS.deviceAudioStore)
  const mediaDevicesStore = useInjection(CONTAINER_IDS.deviceMediaDevicesStore)

  useEffect(() => {
    void mediaDevicesStore.refreshDevices()
  }, [mediaDevicesStore])

  if (!deviceAudioStore.hasAudio) return null

  return (
    <>
      <Button
        appearance='neutral'
        before={
          deviceAudioStore.isMuted ? (
            <Icon24MuteOutline />
          ) : (
            <Icon24VolumeOutline
              fill={deviceAudioStore.isPlaying ? 'var(--vkui--color_icon_positive)' : undefined}
            />
          )
        }
        borderRadiusMode='inherit'
        mode='tertiary'
        title={deviceAudioStore.isMuted ? 'Unmute' : 'Mute'}
        onClick={() => deviceAudioStore.toggleMute()}
      />
      {mediaDevicesStore.canSelectSpeaker && (
        <DeviceSelector
          devices={mediaDevicesStore.speakers}
          selectedDeviceId={mediaDevicesStore.selectedSpeakerId}
          onSelect={(id) => { void deviceAudioStore.switchSpeaker(id) }}
        />
      )}
    </>
  )
})
