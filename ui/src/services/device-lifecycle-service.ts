import { inject, injectable } from 'inversify'

import { DeviceConnection } from '@/store/device-connection'
import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { DeviceBySerialStore } from '@/store/device-by-serial-store'
import { deviceErrorModalStore } from '@/store/device-error-modal-store'
import { deviceBookingGate } from '@/store/device-booking-gate'

import { LogcatService } from './logcat-service'

@injectable()
export class DeviceLifecycleService {
  constructor(
    @inject(CONTAINER_IDS.deviceSerial) private serial: string,
    @inject(CONTAINER_IDS.logcatService) private logcatService: LogcatService,
    @inject(CONTAINER_IDS.deviceConnection) private deviceConnection: DeviceConnection,
    @inject(CONTAINER_IDS.deviceBySerialStore) private deviceBySerialStore: DeviceBySerialStore
  ) {}

  prepareDevice(): void {
    // The barrier was armed when the device container was created; this is what settles it.
    // Manager calls from the stores wait here rather than racing the booking into a 403.
    deviceBookingGate.track(this.serial, this.deviceConnection.useDevice())
    this.deviceBySerialStore.addDeviceChangeListener()
  }

  cleanupDevice(): void {
    deviceBookingGate.release(this.serial)
    this.deviceBySerialStore.removeDeviceChangeListener()
    this.logcatService.terminateLogcat()

    deviceErrorModalStore.clearError()
  }
}
