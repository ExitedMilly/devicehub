import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useInjection } from 'inversify-react'
import { Card, Slider, Switch } from '@vkontakte/vkui'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'
import {
  PARAM_DEFS,
  PARAM_DEF_MAP,
  conflictingWith,
  scenarioWarnings,
} from '@/store/device-constructor-store'

import controls from './sections/controls.module.css'
import styles from './constructor-tab.module.css'

import type { ParamDef, ParamType, ParamValue, ScenarioParam } from '@/store/device-constructor-store'

// Numeric input that keeps the raw edit string locally and commits on blur/Enter —
// per-keystroke Number() would make a leading '-' (negative temperatures are in
// range) untypeable and would silently commit 0 for a cleared field. Same pattern
// as the Temperature operblock (temperature-section.tsx); range errors surface at save.
const NumberField = ({ def, value, onChange }: {
  def: ParamDef
  value: ParamValue
  onChange: (value: ParamValue) => void
}) => {
  const [raw, setRaw] = useState(typeof value === 'number' ? String(value) : '')
  useEffect(() => {
    setRaw(typeof value === 'number' ? String(value) : '')
  }, [value])

  const commit = (text: string): void => {
    const num = Number(text.trim())
    if (text.trim() !== '' && Number.isFinite(num)) {
      onChange(num)
    } else {
      // Empty/invalid edit: revert the field to the last committed value.
      setRaw(typeof value === 'number' ? String(value) : '')
    }
  }

  return (
    <input
      className={controls.input}
      max={def.max}
      min={def.min}
      type='number'
      value={raw}
      onBlur={(e) => commit(e.target.value)}
      onChange={(e) => setRaw(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }}
    />
  )
}

// One row of the builder: the param's value control, chosen by its catalog type.
const ParamValueControl = ({ def, value, onChange }: {
  def: ParamDef
  value: ParamValue
  onChange: (value: ParamValue) => void
}) => {
  switch (def.control) {
    case 'slider':
      return (
        <div className={styles.sliderRow}>
          <Slider
            max={def.max}
            min={def.min}
            step={def.step}
            value={typeof value === 'number' ? value : Number(def.defaultValue)}
            onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
          />
          <span className={styles.sliderValue}>{String(value)}{def.unit ?? ''}</span>
        </div>
      )
    case 'toggle':
      return (
        <Switch
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      )
    case 'select':
      return (
        <select
          className={controls.input}
          value={typeof value === 'string' ? value : String(def.defaultValue)}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    case 'number':
      return <NumberField def={def} value={value} onChange={onChange} />

    case 'text':
      return (
        <input
          className={controls.input}
          placeholder={typeof def.defaultValue === 'string' ? def.defaultValue : undefined}
          type='text'
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'coords': {
      const coords = (value && typeof value === 'object' && 'lat' in value) ? value : { lat: '', lon: '' }
      return (
        <div className={styles.pairRow}>
          <input
            className={controls.input}
            placeholder='Latitude'
            type='text'
            value={coords.lat}
            onChange={(e) => onChange({ ...coords, lat: e.target.value })}
          />
          <input
            className={controls.input}
            placeholder='Longitude'
            type='text'
            value={coords.lon}
            onChange={(e) => onChange({ ...coords, lon: e.target.value })}
          />
        </div>
      )
    }
    case 'hostport': {
      const cfg = (value && typeof value === 'object' && 'host' in value) ? value : { host: '', port: '8080' }
      return (
        <div className={styles.pairRow}>
          <input
            className={controls.input}
            placeholder='Host'
            type='text'
            value={cfg.host}
            onChange={(e) => onChange({ ...cfg, host: e.target.value })}
          />
          <input
            className={controls.input}
            placeholder='Port'
            style={{ maxWidth: 90 }}
            type='number'
            value={cfg.port}
            onChange={(e) => onChange({ ...cfg, port: e.target.value })}
          />
        </div>
      )
    }
  }
}

/**
 * "Constructor" tab — build a custom scenario from runtime operblock parameters,
 * save it (localStorage), manage the saved list. Saved scenarios are APPLIED from
 * the Scenarios block in the Controls tab (single remote-control), by calling the
 * existing store methods — this tab only авторs the definitions.
 *
 * Collision protection while building:
 * (A) each parameter can be added once — added ones disappear from the picker;
 * (B) advisory logical warnings (e.g. airplane ON + Wi-Fi ON) — never blocking;
 * (C) params sharing a device resource (Temperature ↔ Weather) are mutually
 *     exclusive — the conflicting option is disabled in the picker with a reason.
 */
export const ConstructorTab = observer(() => {
  const constructorStore = useInjection(CONTAINER_IDS.deviceConstructorStore)

  const [name, setName] = useState('')
  const [params, setParams] = useState<ScenarioParam[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [picker, setPicker] = useState<ParamType | ''>('')
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [savedFlash, setSavedFlash] = useState<string | null>(null)

  const presentTypes = params.map((p) => p.type)

  const addParam = (): void => {
    const def = picker ? PARAM_DEF_MAP.get(picker) : undefined
    if (!def || presentTypes.includes(def.type)) return
    if (conflictingWith(def.type, presentTypes).length > 0) return
    setParams([...params, { type: def.type, value: def.defaultValue }])
    setPicker('')
    setSaveErrors([])
    setSavedFlash(null)
  }

  const setValue = (type: ParamType, value: ParamValue): void => {
    setParams(params.map((p) => (p.type === type ? { ...p, value } : p)))
  }

  const removeParam = (type: ParamType): void => {
    setParams(params.filter((p) => p.type !== type))
    setSaveErrors([])
  }

  const resetBuilder = (): void => {
    setName('')
    setParams([])
    setEditingId(null)
    setPicker('')
    setSaveErrors([])
  }

  const handleSave = (): void => {
    const errors = constructorStore.validate(name, params)
    if (errors.length > 0) {
      setSaveErrors(errors)
      return
    }
    constructorStore.save(name, params, editingId ?? undefined)
    setSavedFlash(`Saved "${name.trim()}"`)
    resetBuilder()
  }

  const handleEdit = (id: string): void => {
    const s = constructorStore.scenarios.find((x) => x.id === id)
    if (!s) return
    setName(s.name)
    setParams(s.params.map((p) => ({ ...p })))
    setEditingId(id)
    setSaveErrors([])
    setSavedFlash(null)
  }

  const handleDelete = (id: string): void => {
    if (!window.confirm('Delete this scenario?')) return
    constructorStore.remove(id)
    if (editingId === id) resetBuilder()
  }

  const warnings = scenarioWarnings(params)

  // Group the picker options by catalog group, marking added/conflicting ones.
  const groups = [...new Set(PARAM_DEFS.map((d) => d.group))]

  return (
    <div className={styles.stack}>
      {/* ================= Builder ================= */}
      <Card className={styles.card} mode='tint'>
        <div className={styles.cardTitle}>{editingId ? 'Edit scenario' : 'New scenario'}</div>

        <div className={controls.field}>
          <label className={controls.label} htmlFor='ctor-name'>Scenario name</label>
          <input
            className={controls.input}
            id='ctor-name'
            placeholder='e.g. Moscow metro ride'
            type='text'
            value={name}
            onChange={(e) => { setName(e.target.value); setSaveErrors([]) }}
          />
        </div>

        <div className={controls.field}>
          <label className={controls.label} htmlFor='ctor-picker'>Add parameter</label>
          <div className={styles.pickerRow}>
            <select
              className={controls.input}
              id='ctor-picker'
              value={picker}
              onChange={(e) => setPicker(e.target.value as ParamType | '')}
            >
              <option value=''>Choose a parameter…</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {PARAM_DEFS.filter((d) => d.group === g).map((d) => {
                    const added = presentTypes.includes(d.type)
                    const conflicts = conflictingWith(d.type, presentTypes)
                    const conflictLabel = conflicts.length > 0
                      ? ` — conflicts with ${conflicts.map((c) => PARAM_DEF_MAP.get(c)?.label).join(', ')}`
                      : ''
                    return (
                      <option key={d.type} disabled={added || conflicts.length > 0} value={d.type}>
                        {d.label}{added ? ' — added' : conflictLabel}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
            <button
              className={controls.presetButton}
              disabled={!picker}
              style={{ flex: '0 0 auto' }}
              type='button'
              onClick={addParam}
            >
              Add
            </button>
          </div>
        </div>

        {params.length === 0 && (
          <div className={controls.hint}>
            Pick runtime parameters (battery, network, location, sensors…) and set their
            values. The saved scenario appears in the Scenarios block as a one-click preset.
          </div>
        )}

        {params.map((p) => {
          const def = PARAM_DEF_MAP.get(p.type)
          if (!def) return null
          return (
            <div className={styles.paramRow} key={p.type}>
              <div className={styles.paramMain}>
                <div className={styles.paramLabel}>
                  {def.label}
                  {def.unit && def.control !== 'slider' ? ` (${def.unit})` : ''}
                </div>
                <ParamValueControl def={def} value={p.value} onChange={(v) => setValue(p.type, v)} />
                {def.hint && <div className={styles.paramHint}>{def.hint}</div>}
              </div>
              <button
                aria-label={`Remove ${def.label}`}
                className={controls.stopButton}
                style={{ flex: '0 0 auto', minWidth: 0, padding: '8px 12px' }}
                title='Remove parameter'
                type='button'
                onClick={() => removeParam(p.type)}
              >
                ×
              </button>
            </div>
          )
        })}

        {warnings.map((w) => (
          <div className={styles.warning} key={w}>⚠ {w}</div>
        ))}

        {saveErrors.map((e) => (
          <div className={controls.error} key={e}>{e}</div>
        ))}

        <div className={controls.actions}>
          <button
            className={controls.applyButton}
            disabled={!name.trim() || params.length === 0}
            type='button'
            onClick={handleSave}
          >
            {editingId ? 'Save changes' : 'Save scenario'}
          </button>
          {(editingId || params.length > 0 || name) && (
            <button className={controls.presetButton} type='button' onClick={resetBuilder}>
              {editingId ? 'Cancel edit' : 'Clear'}
            </button>
          )}
        </div>

        {savedFlash && <div className={controls.status}>{savedFlash} — apply it from the Scenarios block.</div>}
      </Card>

      {/* ================= Saved list ================= */}
      <Card className={styles.card} mode='tint'>
        <div className={styles.cardTitle}>Saved scenarios</div>

        {constructorStore.scenarios.length === 0 ? (
          <div className={controls.status}>Nothing saved yet.</div>
        ) : (
          constructorStore.scenarios.map((s) => (
            <div className={styles.listRow} key={s.id}>
              <div className={styles.listMain}>
                <div className={styles.listName}>
                  {s.name}
                  {constructorStore.isActive(s.id) && (
                    <span aria-label='active' className={styles.activeDot} role='status' />
                  )}
                </div>
                <div className={styles.listSummary}>
                  {s.params.map((p) => PARAM_DEF_MAP.get(p.type)?.label).filter(Boolean).join(' · ')}
                </div>
              </div>
              {/* Locked while ANY apply is in flight: deleting/editing the applying
                  scenario would release its resource claim mid-run. */}
              <button
                className={controls.presetButton}
                disabled={constructorStore.busyId !== null}
                style={{ flex: '0 0 auto', minWidth: 0 }}
                type='button'
                onClick={() => handleEdit(s.id)}
              >
                Edit
              </button>
              <button
                className={controls.stopButton}
                disabled={constructorStore.busyId !== null}
                style={{ flex: '0 0 auto', minWidth: 0 }}
                type='button'
                onClick={() => handleDelete(s.id)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </Card>
    </div>
  )
})
