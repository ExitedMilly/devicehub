import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'
import { Icon24MusicMicOutline, Icon24MicrophoneSlashOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

export const MicToggleButton = observer(() => {
  const deviceMicStore = useInjection(CONTAINER_IDS.deviceMicStore)

  const handleClick = (): void => {
    if (deviceMicStore.isActive) {
      deviceMicStore.stopMic()
    } else {
      deviceMicStore.startMic()
    }
  }

  return (
    <Button
      appearance='neutral'
      before={
        deviceMicStore.isActive ? (
          <Icon24MusicMicOutline
            fill='var(--vkui--color_icon_positive)'
          />
        ) : (
          <Icon24MicrophoneSlashOutline />
        )
      }
      borderRadiusMode='inherit'
      mode='tertiary'
      title={deviceMicStore.isActive ? 'Disable microphone' : 'Enable microphone'}
      onClick={handleClick}
    />
  )
})
