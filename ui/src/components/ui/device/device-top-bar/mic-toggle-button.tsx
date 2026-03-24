import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'
import { Icon24MusicMicOutline, Icon24MicrophoneSlashOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

export const MicToggleButton = observer(() => {
  const deviceMicStore = useInjection(CONTAINER_IDS.deviceMicStore)

  useEffect(() => {
    deviceMicStore.subscribeToMicState()

    return () => {
      deviceMicStore.unsubscribeFromMicState()
    }
  }, [deviceMicStore])

  const isListening = deviceMicStore.emulatorMicState === 'listening'
  const isDisabled = !isListening && !deviceMicStore.isActive

  const handleClick = (): void => {
    if (deviceMicStore.isActive) {
      deviceMicStore.stopMic()
    } else {
      deviceMicStore.startMic()
    }
  }

  const getTitle = (): string => {
    if (deviceMicStore.isActive) return 'Disable microphone'

    if (!isListening) return 'Microphone unavailable (no app is recording)'

    return 'Enable microphone'
  }

  const getIconColor = (): string | undefined => {
    if (deviceMicStore.isActive) return 'var(--vkui--color_icon_positive)'

    if (isListening) return 'var(--vkui--color_icon_warning)'

    return undefined
  }

  return (
    <Button
      appearance='neutral'
      before={
        deviceMicStore.isActive ? (
          <Icon24MusicMicOutline
            fill={getIconColor()}
          />
        ) : (
          <Icon24MicrophoneSlashOutline
            fill={getIconColor()}
          />
        )
      }
      borderRadiusMode='inherit'
      disabled={isDisabled}
      mode='tertiary'
      title={getTitle()}
      onClick={handleClick}
    />
  )
})
