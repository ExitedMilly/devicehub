import { useTranslation } from 'react-i18next'
import { Div, Title } from '@vkontakte/vkui'

import styles from './how-to-use-tab.module.css'

type ShotProps = {
  src: string
  alt: string
  caption: string
}

const Shot = ({ src, alt, caption }: ShotProps) => (
  <figure className={styles.figure}>
    <img alt={alt} className={styles.image} loading='lazy' src={src} />
    <figcaption className={styles.caption}>{caption}</figcaption>
  </figure>
)

export const HowToUseTab = () => {
  const { t } = useTranslation()

  return (
    <Div className={styles.root}>
      <Title className={styles.lead} level='2'>
        {t('Driving an emulator from the control panel')}
      </Title>
      <p className={styles.intro}>
        {t(
          'Each device is an Android emulator with a manager process of its own. The panel on the right of the control page is where you change what the device reports about itself — its cell, location, sensors, battery, connectivity and identity. Everything below describes the behaviour as it actually works, including the parts that have limits.'
        )}
      </p>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('1. Getting started')}
        </Title>
        <p>
          {t(
            'Open Devices and take a free device with Use. A device already held by someone else cannot be driven; the operblocks below need the device to be booked by you, otherwise the manager refuses the calls.'
          )}
        </p>
        <Shot
          alt='Device list'
          caption={t('Devices list — take a free device with Use.')}
          src='/help/help-01-devices.png'
        />
        <p>
          {t(
            'The control page splits in two: the live screen with its toolbar on the left, and the control panel on the right. The panel has two tabs — Controls, holding the individual operblocks, and Constructor, where scenarios are built and scheduled. Sections are collapsible and several can be open at once.'
          )}
        </p>
        <Shot
          alt='Control page'
          caption={t('Control page: device screen on the left, Controls tab with the operblocks on the right.')}
          src='/help/help-02-control-overview.png'
        />
      </section>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('2. Screen, input and media')}
        </Title>
        <p>
          {t(
            'The toolbar above the screen carries rotation (Portrait / Landscape), screen Quality, and the media controls: audio out with a device picker, microphone in, and camera in. Microphone and camera stay disabled until an app on the device actually opens them — the buttons report that state rather than hiding it. Stop Using releases the device.'
          )}
        </p>
        <Shot
          alt='Device toolbar'
          caption={t('Toolbar: rotation, quality, audio, microphone and camera, and Stop Using.')}
          src='/help/help-07-media-toolbar.png'
        />
        <p>
          {t(
            'Below the screen are the hardware keys — Menu, Home, App switch and Back. Clicking and typing go straight to the device; the screen itself is a live stream, so it updates as the device changes.'
          )}
        </p>
      </section>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('3. Operblocks (Controls tab)')}
        </Title>

        <Title className={styles.subheading} level='3'>
          {t('Cell tower')}
        </Title>
        <p>
          {t(
            'Sets the serving cell the device reports: CID, LAC, optional TAC (LTE) and the radio type (LTE / UMTS / GSM). The operator is read-only and bound to the instance — it is baked into the SIM profile when the container is created, so changing it means recreating the instance, not editing it here.'
          )}
        </p>
        <p>
          {t(
            'Apply restarts the radio and takes about 6-7 seconds; the serving cell then updates live, with a brief signal blip and no reboot. Neighbour cells are different: the framework caches the neighbour list, so anything entered in Neighbor cells appears only after a full emulator reboot. Reset returns the device to its stock cell.'
          )}
        </p>
        <Shot
          alt='Cell tower operblock'
          caption={t('Cell tower: CID, LAC, TAC and RAT, with the operator shown read-only.')}
          src='/help/help-03-cell-tower.png'
        />

        <Title className={styles.subheading} level='3'>
          {t('Network')}
        </Title>
        <p>
          {t(
            'Signal strength, network speed (GPRS through LTE), registration state (home, roaming, searching, unregistered), and the Wi-Fi and airplane switches. Fields are applied independently, so you can change only what you need.'
          )}
        </p>

        <Title className={styles.subheading} level='3'>
          {t('Location')}
        </Title>
        <p>
          {t(
            'Set a point with latitude and longitude and press Set GPS; Stop removes the mock. Walk simulation moves the device along a real route between two points at a chosen speed and profile (foot, bike, driving), with Pause, Resume and Stop. A walk also drives the accelerometer so motion sensors match the movement.'
          )}
        </p>
        <Shot
          alt='Location operblock'
          caption={t('Location: point, the three location syncs, and walk simulation.')}
          src='/help/help-04-location.png'
        />

        <Title className={styles.subheading} level='3'>
          {t('Realistic sensors')}
        </Title>
        <p>
          {t(
            'Keeps every sensor jittering around a plausible value instead of the dead zeros an untouched emulator reports. It yields automatically to any operblock that owns a sensor — set a temperature or a light level and the noise stops touching that one until you release it.'
          )}
        </p>

        <Title className={styles.subheading} level='3'>
          {t('Temperature, Light, Pose')}
        </Title>
        <p>
          {t(
            'Temperature holds an ambient value in degrees Celsius and needs an explicit Apply. Light sets illuminance in lux. Pose sets a single device rotation from pitch, yaw and roll, with presets for the common orientations. Temperature and Weather from location both own the temperature sensor, so turning one on switches the other off.'
          )}
        </p>

        <Title className={styles.subheading} level='3'>
          {t('Battery, Phone number, Bluetooth, Proxy')}
        </Title>
        <p>
          {t(
            'Battery sets charge level and charging state. Phone number is a runtime override — the instance default is baked into the SIM profile, so this one lasts until the radio re-reads it. Bluetooth toggles the adapter and takes a few seconds to settle. Proxy points the device at an HTTP proxy; the host address is detected for you, and it is the docker gateway rather than the usual emulator alias.'
          )}
        </p>

        <Title className={styles.subheading} level='3'>
          {t('Backup')}
        </Title>
        <p>
          {t(
            'Creates an archive of the installed third-party apps and the contents of /sdcard, and restores it later. It takes minutes rather than seconds, so poll the status instead of waiting on the request. App user data is not captured, and a restore adds to the device rather than wiping it.'
          )}
        </p>
      </section>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('4. Location-driven syncs')}
        </Title>
        <p>
          {t(
            'Three switches in Location make other subsystems follow the device position. Each one re-queries only after the device has moved far enough, so they stay affordable during a walk.'
          )}
        </p>
        <ul className={styles.list}>
          <li>
            <b>{t('Weather from location')}</b>{' '}
            {t(
              '— pulls the real weather for the current point and writes it to the temperature, humidity and pressure sensors. Re-queries after roughly 10 km of movement, or every 30 minutes when the device stands still, since real weather drifts.'
            )}
          </li>
          <li>
            <b>{t('Sync Wi-Fi with location (BSSID)')}</b>{' '}
            {t(
              '— injects the Wi-Fi networks really seen at that location into the scan results, so an app cross-checking GPS against nearby Wi-Fi sees a consistent picture. Threshold is about 0.7 km, because Wi-Fi is a local fingerprint. This is app-level only: it changes what apps reading scan results see, and does not move the system location.'
            )}
          </li>
          <li>
            <b>{t('Sync cell towers with location')}</b>{' '}
            {t(
              '— sets the serving cell to the nearest real LTE tower of this instance operator. Threshold is 1.5 km, because each change restarts the radio for several seconds. If the nearest tower has not changed the call returns without touching the device. Only the serving cell follows; neighbours still need a reboot. Applying or resetting the Cell tower operblock by hand switches this sync off, so the two never fight.'
            )}
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('5. Scenarios and the Constructor')}
        </Title>
        <p>
          {t(
            'The Scenarios section holds one-click presets, your saved scenarios, and ambient loops that keep changing the device until stopped — a day/night light cycle, periodic rotation and battery drain. Owners of the same resource replace each other, so the newest one wins and you never end up with two things driving the same sensor.'
          )}
        </p>
        <Shot
          alt='Scenarios operblock'
          caption={t('Scenarios: presets, saved scenarios and ambient loops.')}
          src='/help/help-05-scenarios.png'
        />
        <p>
          {t(
            'The Constructor tab is where scenarios are built. Pick runtime parameters — battery, network, location, sensors, connectivity, phone number — give them values and save; the scenario then appears in Scenarios as a one-click preset. Scenarios are stored per device on the manager, so they survive a page reload and a manager restart.'
          )}
        </p>
        <p>
          {t(
            'The Schedule card runs saved scenarios on a timer: a local HH:MM time, daily or once, and an optional jitter that spreads the actual firing over a window. It runs on the manager, so it keeps working with no browser open. Between scheduled runs your manual changes stand; the next run re-applies the scenario.'
          )}
        </p>
        <Shot
          alt='Constructor tab'
          caption={t('Constructor: scenario builder, saved scenarios and the schedule.')}
          src='/help/help-06-constructor.png'
        />
      </section>

      <section className={styles.section}>
        <Title className={styles.heading} level='3'>
          {t('6. Device masking, and what it does not cover')}
        </Title>
        <p>
          {t(
            'The emulator presents itself as a Redmi Note 12 4G rather than as an emulator image. A check that reads the ordinary device properties sees a consistent handset: model, brand, manufacturer, build fingerprint, SoC and board all match that phone, and the device characteristics no longer say "emulator".'
          )}
        </p>
        <p className={styles.warning}>
          {t(
            'This is app-level cover against naive property checks, not a disguise that survives scrutiny. Several tells remain and are known:'
          )}
        </p>
        <ul className={styles.list}>
          <li>
            {t(
              'Properties in the verified /system partition are untouched, so build tags, build type and build id still read as an engineering emulator build, and they contradict the fingerprint above.'
            )}
          </li>
          <li>
            {t(
              'The system_dlkm partition and the boot image keep their original emulator identity for the same reason.'
            )}
          </li>
          <li>
            {t(
              'Nothing outside the property system is masked at all: the goldfish and qemu device nodes, the software renderer reported by the graphics stack, the emulator sensor names, and the x86 architecture.'
            )}
          </li>
          <li>
            {t(
              'Hardware-backed attestation, Play Integrity included, is not addressed and cannot be — it does not rely on the properties this masks.'
            )}
          </li>
        </ul>
        <p>
          {t(
            'Treat it as cover against checks that read device properties, and assume a determined check still identifies the device as an emulator.'
          )}
        </p>
      </section>
    </Div>
  )
}
