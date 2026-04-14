import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Button } from '@vkontakte/vkui'
import { Icon24CameraOutline } from '@vkontakte/icons'

import { DeviceSelector } from './device-selector'
import { CONTAINER_IDS } from '@/config/inversify/container-ids'

export const CameraToggleButton = observer(() => {
  const deviceCameraStore = useInjection(CONTAINER_IDS.deviceCameraStore)
  const mediaDevicesStore = useInjection(CONTAINER_IDS.deviceMediaDevicesStore)

  useEffect(() => {
    void mediaDevicesStore.initForDevicePage()
    void deviceCameraStore.subscribeToCameraState()

    return () => {
      deviceCameraStore.unsubscribeFromCameraState()
    }
  }, [deviceCameraStore, mediaDevicesStore])

  const isCameraActive = deviceCameraStore.emulatorCameraState === 'active'
  const isDisabled = !isCameraActive && !deviceCameraStore.isActive

  const handleClick = (): void => {
    if (deviceCameraStore.isActive) {
      deviceCameraStore.stopCamera()
    } else {
      void deviceCameraStore.startCamera()
    }
  }

  const getTitle = (): string => {
    if (deviceCameraStore.isActive) return 'Disable camera'
    if (!isCameraActive) return 'Camera unavailable (no app is using camera)'
    return 'Enable camera'
  }

  const getIconColor = (): string | undefined => {
    if (deviceCameraStore.isActive) return 'var(--vkui--color_icon_positive)'
    if (isCameraActive) return 'var(--vkui--color_icon_warning)'
    return undefined
  }

  return (
    <>
      <Button
        appearance='neutral'
        before={<Icon24CameraOutline fill={getIconColor()} />}
        borderRadiusMode='inherit'
        disabled={isDisabled}
        mode='tertiary'
        title={getTitle()}
        onClick={handleClick}
      />
      <DeviceSelector
        devices={mediaDevicesStore.cameras}
        selectedDeviceId={mediaDevicesStore.selectedCameraId}
        emptyMessage='No camera list yet. Grant camera access once to populate devices.'
        onRequestAccess={() => mediaDevicesStore.requestAccess('video')}
        onSelect={(id) => { void deviceCameraStore.switchCamera(id) }}
      />
    </>
  )
})
