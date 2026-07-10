import { Icon28KeyboardOutline } from '@vkontakte/icons'

import { PanelSection } from './panel-section'
import { DeviceButtonsControl } from '../tabs/dashboard-tab/device-buttons-control'

/**
 * "Device Buttons" block — the existing DeviceButtonsControl (power / volume / special
 * keys / media) rendered `bare` (without its own ContentCard) so it lives inside a
 * collapsible PanelSection like every other operblock block. No active state (momentary
 * actions), so no green dot.
 */
export const DeviceButtonsSection = () => (
  <PanelSection icon={<Icon28KeyboardOutline />} title='Device Buttons'>
    <DeviceButtonsControl bare />
  </PanelSection>
)
