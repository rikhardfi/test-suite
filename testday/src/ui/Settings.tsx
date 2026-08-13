import { useEffect, useState } from 'react'
import type { Settings as SettingsShape } from '../model/storage'
import type { Athlete } from '../model/protocol'
import type { StoragePaths } from '../../electron/ipc'

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

      <StorageSettings />

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

/**
 * Where recordings go, shown only in the desktop app because it is the only
 * build that has anywhere to put them. The operator should be able to answer
 * "where is my data" without asking anyone.
 */
function StorageSettings() {
  const bridge = window.testday
  const [paths, setPaths] = useState<StoragePaths | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.paths().then(setPaths)
  }, [bridge])

  if (!bridge) {
    return (
      <section className="panel pad">
        <h2>Recordings</h2>
        <p className="banner error">
          This is the browser build. Sessions are kept inside this browser and are rewritten every 15
          seconds rather than written as they happen. Use the desktop app for anything with an athlete
          on it.
        </p>
      </section>
    )
  }

  return (
    <section className="panel pad">
      <h2>Recordings</h2>
      <p className="muted small">
        Every sample is appended to a file and flushed to disk as it happens. Journals are written
        locally and copied to the second location only once a session is closed, because a sync client
        cannot be trusted with a file that is still being written.
      </p>
      <div className="field-grid">
        <label>
          Written to
          <input readOnly value={paths?.sessionsDir ?? '…'} />
        </label>
        <label>
          Second copy
          <input readOnly value={paths?.mirrorDir ?? 'Not configured'} />
        </label>
      </div>
      <div className="row">
        <button onClick={() => void bridge.chooseMirrorFolder().then(setPaths)}>
          Choose second copy folder
        </button>
        <button className="ghost" onClick={() => void bridge.setMirrorFolder(null).then(setPaths)}>
          Clear
        </button>
        <button className="ghost" onClick={() => void bridge.reveal(null)}>
          Open in Finder
        </button>
      </div>
      {!paths?.mirrorDir && (
        <p className="banner error">
          No second copy is configured. A single disk failure would take the recordings with it.
        </p>
      )}

      <h3>Quitting</h3>
      <p className="muted small">
        Quitting while a session is recording always asks first, and that is not optional. This
        covers the rest of the time.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={paths?.confirmQuitWhenIdle ?? true}
          onChange={(e) => void bridge.setConfirmQuitWhenIdle(e.target.checked).then(setPaths)}
        />
        Ask before quitting even when nothing is recording
      </label>

      <h3>Diagnostics</h3>
      <p className="muted small">
        A log of what the app did: sessions opened and closed, sensors connecting and dropping,
        failed writes, crashes. No athlete names and no measurements go into it, so it is safe to
        send on when something has gone wrong.
      </p>
      <div className="row">
        <input readOnly value={paths?.logFile ?? '…'} />
        <button className="ghost nowrap" onClick={() => void bridge.revealLog()}>
          Show log
        </button>
      </div>
    </section>
  )
}
