import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Switch } from '@vkontakte/vkui'
import { Icon28MagicWandOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import { PARAM_DEF_MAP } from '@/store/device-constructor-store'

import { PanelSection } from './panel-section'

import styles from './controls.module.css'

import type { CSSProperties } from 'react'
import type { ScenarioPreset } from '@/store/device-scenarios-store'

const PRESETS: Array<{ value: ScenarioPreset; label: string }> = [
  { value: 'onCharge', label: 'On charge' },
  { value: 'metro', label: 'Metro' },
  { value: 'reset', label: 'Reset' },
  { value: 'lowBattery', label: 'Low battery' },
]

// Active preset gets a green (positive) tint + label colour. The .presetButton
// class keeps padding/border-radius constant, so only colours change (no jump).
const PRESET_ACTIVE: CSSProperties = {
  background: 'var(--vkui--color_background_positive_tint)',
  color: 'var(--vkui--color_text_positive)',
}

export const ScenariosSection = observer(() => {
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)
  const constructorStore = useInjection(CONTAINER_IDS.deviceConstructorStore)

  // Any apply in flight (built-in preset OR custom scenario) disables both button
  // groups — steps interleaving across two concurrent runs would race on the stores.
  const busy = scenarios.busyPreset !== null || constructorStore.busyId !== null

  const active =
    scenarios.activePresets.size > 0 || scenarios.hasActiveCustomScenarios ||
    scenarios.cycleOn || scenarios.rotateOn || scenarios.batteryDrainEnabled

  return (
    <PanelSection active={active} icon={<Icon28MagicWandOutline />} title='Scenarios'>

      {/* ============== Presets (one-shot) ============== */}

      <div className={styles.sectionTitle}>Presets</div>

      <div className={styles.presets}>
        {PRESETS.map((p) => (
          <button
            key={p.value}
            className={styles.presetButton}
            disabled={busy}
            style={scenarios.isPresetActive(p.value) ? PRESET_ACTIVE : undefined}
            type='button'
            onClick={() => scenarios.applyPreset(p.value)}
          >
            {scenarios.busyPreset === p.value ? 'Applying…' : p.label}
          </button>
        ))}
      </div>

      {scenarios.statusText && (
        <div className={scenarios.errorMessage ? styles.error : styles.status}>
          {scenarios.statusText}
        </div>
      )}

      {/* ============== My scenarios (user-built, Constructor tab) ============== */}

      <hr className={styles.divider} />

      <div className={styles.sectionTitle}>My scenarios</div>

      {constructorStore.scenarios.length === 0 ? (
        <div className={styles.status}>None yet — build one in the Constructor tab.</div>
      ) : (
        <div className={styles.presets}>
          {constructorStore.scenarios.map((s) => (
            <button
              key={s.id}
              className={styles.presetButton}
              disabled={busy}
              style={constructorStore.isActive(s.id) ? PRESET_ACTIVE : undefined}
              title={s.params.map((p) => PARAM_DEF_MAP.get(p.type)?.label).filter(Boolean).join(' · ')}
              type='button'
              onClick={() => { void constructorStore.applyScenario(s.id) }}
            >
              {constructorStore.busyId === s.id ? 'Applying…' : s.name}
            </button>
          ))}
        </div>
      )}

      {constructorStore.statusText && (
        <div className={constructorStore.errorMessage ? styles.error : styles.status}>
          {constructorStore.statusText}
        </div>
      )}

      <hr className={styles.divider} />

      {/* ============== Ambient (timer-driven) ============== */}

      <div className={styles.sectionTitle}>Ambient</div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-cycle'>Day / Night cycle</label>
        <Switch
          checked={scenarios.cycleOn}
          id='scn-cycle'
          onChange={(e) => scenarios.setCycleOn(e.target.checked)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-cycle-period'>Cycle period (s)</label>
        <input
          className={styles.input}
          id='scn-cycle-period'
          min={4}
          type='number'
          value={scenarios.cyclePeriodSec}
          onChange={(e) => scenarios.setCyclePeriodSec(Number(e.target.value))}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-rotate'>Periodic rotation</label>
        <Switch
          checked={scenarios.rotateOn}
          id='scn-rotate'
          onChange={(e) => scenarios.setRotateOn(e.target.checked)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-rotate-interval'>Rotation interval (s)</label>
        <input
          className={styles.input}
          id='scn-rotate-interval'
          min={2}
          type='number'
          value={scenarios.rotateIntervalSec}
          onChange={(e) => scenarios.setRotateIntervalSec(Number(e.target.value))}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-drain'>Battery drain</label>
        <Switch
          checked={scenarios.batteryDrainEnabled}
          id='scn-drain'
          onChange={() => scenarios.toggleBatteryDrain()}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-drain-from'>From, %</label>
        <input
          className={styles.input}
          disabled={scenarios.batteryDrainEnabled}
          id='scn-drain-from'
          max={100}
          min={1}
          type='number'
          value={scenarios.drainStartPct}
          onBlur={(e) => scenarios.setDrainStart(Number(e.target.value))}
          onChange={(e) => scenarios.setDrainStart(Number(e.target.value))}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-drain-to'>To, %</label>
        <input
          className={styles.input}
          disabled={scenarios.batteryDrainEnabled}
          id='scn-drain-to'
          max={99}
          min={0}
          type='number'
          value={scenarios.drainFloorPct}
          onBlur={(e) => scenarios.setDrainFloor(Number(e.target.value))}
          onChange={(e) => scenarios.setDrainFloor(Number(e.target.value))}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor='scn-drain-every'>1% every, s</label>
        <input
          className={styles.input}
          disabled={scenarios.batteryDrainEnabled}
          id='scn-drain-every'
          max={600}
          min={2}
          type='number'
          value={scenarios.drainIntervalSec}
          onBlur={(e) => scenarios.setDrainInterval(Number(e.target.value))}
          onChange={(e) => scenarios.setDrainInterval(Number(e.target.value))}
        />
      </div>
    </PanelSection>
  )
})
