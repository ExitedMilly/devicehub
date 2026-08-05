import { useTranslation } from 'react-i18next'
import { Button, Div, Title } from '@vkontakte/vkui'
import { Icon24ExternalLinkOutline } from '@vkontakte/icons'

import styles from './api-tab.module.css'

const DOCS_URL = '/api-docs/'
const SPEC_URL = '/api-docs/openapi.json'

export const ApiTab = () => {
  const { t } = useTranslation()

  return (
    <Div className={styles.root}>
      <Title className={styles.lead} level='2'>
        {t('Manager REST API')}
      </Title>
      <p className={styles.intro}>
        {t(
          'Every operblock in the control panel is a call against the per-device manager API. The reference below is generated from the manager source, so it always describes the build you are running. It documents the contract only — the page sends no requests. To call the API, take the machine-readable document and drive it from a real client.'
        )}
      </p>

      <div className={styles.actions}>
        <Button
          after={<Icon24ExternalLinkOutline height={16} width={16} />}
          Component='a'
          href={DOCS_URL}
          rel='noreferrer'
          size='l'
          target='_blank'
        >
          {t('Open API reference')}
        </Button>
        <Button Component='a' href={SPEC_URL} mode='secondary' rel='noreferrer' size='l' target='_blank'>
          {t('Download openapi.json')}
        </Button>
      </div>

      <iframe className={styles.frame} src={DOCS_URL} title={t('API reference')} />
    </Div>
  )
}
