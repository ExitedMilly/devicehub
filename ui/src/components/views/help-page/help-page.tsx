import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Panel, View } from '@vkontakte/vkui'

import { TabsPanel } from '@/components/lib/tabs-panel'
import { HowToUseTab } from '@/components/ui/help-tabs/how-to-use-tab'
import { ApiTab } from '@/components/ui/help-tabs/api-tab'

import { getHelpApiRoute, getHelpRoute } from '@/constants/route-paths'

import styles from './help-page.module.css'

import type { TabsContent } from '@/components/lib/tabs-panel'

export const HelpPage = () => {
  const { t } = useTranslation()

  const tabsContent = useMemo<TabsContent[]>(
    () => [
      {
        id: getHelpRoute(),
        title: t('How to use'),
        ariaControls: 'tab-content-how-to-use',
        content: <HowToUseTab />,
      },
      {
        id: getHelpApiRoute(),
        title: t('API'),
        ariaControls: 'tab-content-api',
        content: <ApiTab />,
      },
    ],
    [t]
  )

  return (
    <View activePanel='help' className={styles.helpPage}>
      <Panel id='help'>
        <TabsPanel content={tabsContent} routeSync={true} />
      </Panel>
    </View>
  )
}
