import { useEffect } from 'react'
import { useInjection } from 'inversify-react'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

export const useAudioStreaming = (): void => {
  const deviceAudioStore = useInjection(CONTAINER_IDS.deviceAudioStore)

  useEffect(() => {
    deviceAudioStore.startAudioStreaming().catch((err: unknown) => {
      console.error('[useAudioStreaming] Failed to start audio streaming:', err)
    })

    return (): void => {
      deviceAudioStore.stopAudioStreaming()
    }
  }, [deviceAudioStore])
}
