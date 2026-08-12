import type { Settings as SettingsShape } from '../model/storage'
import type { Athlete } from '../model/protocol'

interface Props {
  settings: SettingsShape
  onChange: (settings: SettingsShape) => void
  onResetAthlete: () => void
}

export function Settings({ settings, onChange, onResetAthlete }: Props) {
  const setAthlete = (patch: Partial<Athlete>) =>
    onChange({ ...settings, athlete: { ...settings.athlete, ...patch } })

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <button className="ghost" onClick={onResetAthlete}>
          Reset athlete
        </button>
      </div>

      <section className="panel pad">
        <h2>Athlete</h2>
        <p className="muted small">
          FTP resolves every %-based protocol target, and mass drives the W/kg figures in analysis.
        </p>
        <div className="field-grid">
          <label>
            Name
            <input value={settings.athlete.name} onChange={(e) => setAthlete({ name: e.target.value })} />
          </label>
          <label>
            Body mass (kg)
            <input
              type="number"
              step={0.1}
              value={settings.athlete.massKg}
              onChange={(e) => setAthlete({ massKg: Number(e.target.value) })}
            />
          </label>
          <label>
            FTP / threshold power (W)
            <input
              type="number"
              value={settings.athlete.ftpWatts}
              onChange={(e) => setAthlete({ ftpWatts: Number(e.target.value) })}
            />
          </label>
          <label>
            Max heart rate (bpm)
            <input
              type="number"
              value={settings.athlete.maxHr ?? ''}
              onChange={(e) => setAthlete({ maxHr: Number(e.target.value) || undefined })}
            />
          </label>
          <label>
            Resting heart rate (bpm)
            <input
              type="number"
              value={settings.athlete.restingHr ?? ''}
              onChange={(e) => setAthlete({ restingHr: Number(e.target.value) || undefined })}
            />
          </label>
          <label>
            Birth year
            <input
              type="number"
              value={settings.athlete.birthYear ?? ''}
              onChange={(e) => setAthlete({ birthYear: Number(e.target.value) || undefined })}
            />
          </label>
        </div>
      </section>

      <section className="panel pad">
        <h2>Sensors</h2>
        <div className="field-grid">
          <label>
            Wheel circumference (m)
            <input
              type="number"
              step={0.001}
              value={settings.wheelCircumferenceM}
              onChange={(e) => onChange({ ...settings, wheelCircumferenceM: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="muted small">
          Only used to turn wheel revolutions into speed. 700×25c is about 2.096 m.
        </p>
      </section>

      <section className="panel pad">
        <h2>Data</h2>
        <p className="muted small">
          Sessions, protocols and settings stay in this browser — IndexedDB for recordings, localStorage for
          settings. Nothing is uploaded anywhere. Export from the Analysis tab before clearing site data.
        </p>
      </section>

      <section className="panel pad">
        <h2>Keyboard</h2>
        <ul className="keys">
          <li>
            <kbd>Space</kbd> start / pause
          </li>
          <li>
            <kbd>→</kbd> next step
          </li>
          <li>
            <kbd>←</kbd> restart step, then previous
          </li>
          <li>
            <kbd>↑</kbd> <kbd>↓</kbd> intensity ±1%
          </li>
          <li>
            <kbd>L</kbd> enter a lactate value
          </li>
        </ul>
      </section>
    </div>
  )
}
