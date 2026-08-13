import { useState } from 'react'
import type { Environment } from '../model/session'
import type { MetricUpdate } from '../ble/types'
import { Modal } from './Modal'

/**
 * Conditions the test was run in.
 *
 * This exists whether or not an environment monitor connects, and that is the
 * point: unrecorded conditions make an airway result uninterpretable
 * afterwards, and afterwards is when it gets interpreted. Cold, dry or
 * CO₂-loaded indoor air is a conditioning load the airway has to carry, so it
 * is part of the measurement rather than context around it.
 *
 * Anything a connected monitor already knows is filled in and labelled, so the
 * operator is correcting rather than transcribing.
 */
export function EnvironmentForm({
  metrics,
  existing,
  onSave,
  onClose,
}: {
  metrics: MetricUpdate
  existing?: Environment
  onSave: (reading: Omit<Environment, 'at'>) => void
  onClose: () => void
}) {
  const fromSensor = {
    tempC: metrics.ambientTempC,
    humidityPct: metrics.humidityPct,
    co2Ppm: metrics.co2Ppm,
    pressureHpa: metrics.pressureHpa,
  }
  const sensed = Object.values(fromSensor).some((v) => v != null)

  const [form, setForm] = useState({
    tempC: text(existing?.tempC ?? fromSensor.tempC),
    humidityPct: text(existing?.humidityPct ?? fromSensor.humidityPct),
    co2Ppm: text(existing?.co2Ppm ?? fromSensor.co2Ppm),
    pressureHpa: text(existing?.pressureHpa ?? fromSensor.pressureHpa),
    altitudeM: text(existing?.altitudeM),
    setting: existing?.setting ?? ('indoor' as 'indoor' | 'outdoor'),
    note: existing?.note ?? '',
  })

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = {
      tempC: num(form.tempC),
      humidityPct: num(form.humidityPct),
      co2Ppm: num(form.co2Ppm),
      pressureHpa: num(form.pressureHpa),
      altitudeM: num(form.altitudeM),
    }
    // Whether a number came from a sensor or from a person changes how much
    // weight it can carry later, so the record says which.
    const edited = (Object.keys(fromSensor) as (keyof typeof fromSensor)[]).some(
      (key) => fromSensor[key] != null && parsed[key] !== fromSensor[key],
    )
    const manual = (Object.keys(parsed) as (keyof typeof parsed)[]).some(
      (key) => parsed[key] != null && !(key in fromSensor && fromSensor[key as keyof typeof fromSensor] != null),
    )
    const source: Environment['source'] =
      sensed && !edited && !manual ? 'sensor' : sensed ? 'mixed' : 'manual'

    onSave({ ...parsed, setting: form.setting, note: form.note || undefined, source })
  }

  return (
    <Modal onClose={onClose} className="narrow" as="form" onSubmit={submit}>
        <h2>Conditions</h2>
        <p className="muted small">
          {sensed
            ? 'Filled in from the connected monitor. Correct anything that is wrong; the record keeps track of which values were measured and which were typed.'
            : 'No environment monitor is connected, so these are entered by hand. Recording them is worth doing anyway: a result without conditions cannot be read properly a year later.'}
        </p>

        <div className="field-grid">
          <label>
            Air temperature (°C)
            <input
              inputMode="decimal"
              value={form.tempC}
              onChange={(e) => set('tempC')(e.target.value)}
              placeholder="21"
            />
          </label>
          <label>
            Relative humidity (%)
            <input
              inputMode="decimal"
              value={form.humidityPct}
              onChange={(e) => set('humidityPct')(e.target.value)}
              placeholder="40"
            />
          </label>
          <label>
            CO₂ (ppm)
            <input
              inputMode="numeric"
              value={form.co2Ppm}
              onChange={(e) => set('co2Ppm')(e.target.value)}
              placeholder="600"
            />
          </label>
          <label>
            Pressure (hPa)
            <input
              inputMode="decimal"
              value={form.pressureHpa}
              onChange={(e) => set('pressureHpa')(e.target.value)}
              placeholder="1013"
            />
          </label>
          <label>
            Altitude (m)
            <input
              inputMode="numeric"
              value={form.altitudeM}
              onChange={(e) => set('altitudeM')(e.target.value)}
              placeholder="90"
            />
          </label>
          <label>
            Setting
            <select
              value={form.setting}
              onChange={(e) => set('setting')(e.target.value as 'indoor' | 'outdoor')}
            >
              <option value="indoor">Indoor</option>
              <option value="outdoor">Outdoor</option>
            </select>
          </label>
        </div>

        <label>
          Note
          <input
            value={form.note}
            onChange={(e) => set('note')(e.target.value)}
            placeholder="Ventilation off, lab window open"
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
    </Modal>
  )
}

const text = (value: number | undefined): string =>
  value == null ? '' : String(Number(value.toFixed(1)))

/** Empty means not recorded, which is not the same as zero. */
function num(value: string): number | undefined {
  const trimmed = value.trim().replace(',', '.')
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}
