import { Accordion, Card } from '@vkontakte/vkui'

import styles from './panel-section.module.css'

import type { ReactNode } from 'react'

interface PanelSectionProps {
  title: string
  icon?: ReactNode
  /** Green "active" dot in the header when the section has something running. */
  active?: boolean
  /** Start collapsed (default) or expanded. Each block toggles independently. */
  defaultExpanded?: boolean
  children: ReactNode
}

/**
 * One operblock block of the device control panel: a VKUI `Card mode="tint"` (the same
 * card surface as DeviceButtonsControl, so blocks aren't flat/black) holding a
 * collapsible Accordion whose header shows an icon + title + a green active dot. Each
 * block owns its own expand state (uncontrolled Accordion), so any number of blocks can
 * be open at once and each collapses independently — no shared single-open controller.
 * All blocks start collapsed. Themed entirely via VKUI tokens.
 */
export const PanelSection = ({ title, icon, active, defaultExpanded = false, children }: PanelSectionProps) => (
  <Card className={styles.card} mode='tint'>
    <Accordion defaultExpanded={defaultExpanded}>
      <Accordion.Summary before={icon}>
        <span className={styles.summary}>
          <span className={styles.title}>{title}</span>
          {active && <span aria-label='active' className={styles.activeDot} role='status' />}
        </span>
      </Accordion.Summary>
      <Accordion.Content>
        <div className={styles.content}>{children}</div>
      </Accordion.Content>
    </Accordion>
  </Card>
)
