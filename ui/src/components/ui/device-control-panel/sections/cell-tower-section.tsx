import { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Icon28RadiowavesLeftAndRightOutline } from '@vkontakte/icons'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

import { PanelSection } from './panel-section'

import styles from './controls.module.css'

import type { CellRat } from '@/store/device-cell-tower-store'

const RAT_OPTIONS: Array<{ value: CellRat; label: string }> = [
  { value: 'lte', label: 'LTE' },
  { value: 'umts', label: 'UMTS (3G)' },
  { value: 'gsm', label: 'GSM (2G)' },
]

/**
 * "Cell tower" operblock — manual serving-cell + neighbour spoofing via the op-v4
 * RIL property patch. Operator is bound to the instance (op-shim bakes the name at
 * creation; only the numeric code moves at runtime), so it is shown read-only and
 * the spoofed cell always belongs to it. Neighbours only surface after a reboot
 * (the framework caches the cell-info list), which the UI states plainly.
 */
export const CellTowerSection = observer(() => {
  const cell = useInjection(CONTAINER_IDS.deviceCellTowerStore)
  const scenarios = useInjection(CONTAINER_IDS.deviceScenariosStore)

  useEffect(() => { void cell.fetchStatus() }, [cell])

  // Newest-wins with the "Sync cell towers with location" toggle: a deliberate
  // manual apply/reset takes over, so turn the auto-sync off (else it would
  // re-point the serving cell on the next move). Mirrors GPS↔walk exclusion.
  const applyManual = (): void => {
    scenarios.toggleCellSync(false)
    void cell.apply()
  }

  const resetManual = (): void => {
    scenarios.toggleCellSync(false)
    void cell.reset()
  }

  return (
    <PanelSection
      active={cell.applied}
      icon={<Icon28RadiowavesLeftAndRightOutline />}
      title='Cell tower'
    >
      <div className={styles.hint}>
        Operator: <strong>{cell.operatorName || '—'}</strong>
        {cell.operatorPlmn ? ` (${cell.operatorPlmn})` : ''} · bound to the instance.
        To change operator, recreate the instance.
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor='cell-cid'>CID</label>
          <input
            className={styles.input}
            id='cell-cid'
            inputMode='numeric'
            placeholder='e.g. 12345'
            type='number'
            value={cell.cid}
            onChange={(e) => cell.setCid(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor='cell-lac'>LAC</label>
          <input
            className={styles.input}
            id='cell-lac'
            inputMode='numeric'
            placeholder='0..65535'
            type='number'
            value={cell.lac}
            onChange={(e) => cell.setLac(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor='cell-tac'>TAC <span style={{ opacity: 0.6 }}>(LTE, optional)</span></label>
          <input
            className={styles.input}
            id='cell-tac'
            inputMode='numeric'
            placeholder='defaults to LAC'
            type='number'
            value={cell.tac}
            onChange={(e) => cell.setTac(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor='cell-rat'>RAT</label>
          <select
            className={styles.input}
            id='cell-rat'
            value={cell.rat}
            onChange={(e) => cell.setRat(e.target.value as CellRat)}
          >
            {RAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.hint} style={{ marginTop: 10, marginBottom: 0 }}>
        Apply restarts the radio (~6s, brief signal blip) so the serving cell above
        updates live — no full reboot needed.
      </div>

      <hr className={styles.divider} />

      <div className={styles.sectionTitle}>Neighbor cells (optional)</div>
      <div className={styles.field}>
        <input
          className={styles.input}
          id='cell-neighbors'
          placeholder='cid:lac:rssi, cid:lac:rssi'
          type='text'
          value={cell.neighbors}
          onChange={(e) => cell.setNeighbors(e.target.value)}
        />
      </div>
      <div className={styles.hint} style={{ marginTop: 8, marginBottom: 0 }}>
        rssi is asu 0..31, up to 8 neighbors. Note: neighbors appear after an
        emulator reboot — the framework caches the cell list, so unlike the serving
        cell they do not update live.
      </div>

      <div className={styles.actions}>
        <button
          className={styles.applyButton}
          disabled={!cell.isValid || cell.isApplying}
          type='button'
          onClick={applyManual}
        >
          {cell.isApplying ? 'Applying...' : 'Apply'}
        </button>
        <button
          className={styles.restoreButton}
          disabled={cell.isApplying}
          type='button'
          onClick={resetManual}
        >
          Reset
        </button>
      </div>

      {cell.statusText && (
        <div className={cell.errorMessage ? styles.error : styles.status}>
          {cell.statusText}
        </div>
      )}
    </PanelSection>
  )
})
