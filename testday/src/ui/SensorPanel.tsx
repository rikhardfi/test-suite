import { useState } from 'react'
import { SENSOR_PROFILES, isWebBluetoothAvailable, type SensorManager, type SensorProfile } from '../ble/manager'
import { Simulator } from '../ble/simulator'
import { BluetoothChooser, useBluetoothChooser } from './BluetoothChooser'
import { useLiveMetrics, useSensorDevices } from './hooks'
import { metricLabel } from '../ble/metrics'
import type { MetricKey } from '../ble/types'


const SOURCE_METRICS: { key: MetricKey; label: string }[] = [
  { key: 'power', label: 'Power' },
  { key: 'heartRate', label: 'Heart rate' },
  { key: 'cadence', label: 'Cadence' },
  { key: 'speedMs', label: 'Speed' },
]

interface Props {
  manager: SensorManager
  ftpWatts: number
  onClose: () => void
}

export function SensorPanel({ manager, ftpWatts, onClose }: Props) {
  const devices = useSensorDevices(manager)
  const metrics = useLiveMetrics(manager, 4)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const chooser = useBluetoothChooser(connecting !== null)

  const add = async (profile: SensorProfile) => {
    setError(null)
    setConnecting(profile.key)
    try {
      await manager.connect(profile)
    } catch (e) {
      // A cancelled chooser is a normal outcome, not a failure worth showing.
      const message = e instanceof Error ? e.message : String(e)
      if (!/user cancelled|chooser/i.test(message)) setError(message)
    } finally {
      setConnecting(null)
    }
  }

  // Leaving the panel with a scan in flight would otherwise leave
  // `requestDevice` pending for the life of the app.
  const close = () => {
    if (connecting !== null) chooser.cancel()
    onClose()
  }

  const addSimulator = () => {
    if (devices.some((d) => d.id === 'sim:trainer')) return
    const simulator = new Simulator(manager, { ftpWatts })
    manager.addVirtual(simulator)
    void simulator.start()
  }

  const supported = isWebBluetoothAvailable()

  const captureUnknown = async () => {
    const uuid = window.prompt(
      'Service UUID to capture from.\n\n' +
        'Web Bluetooth will not list services that were not asked for, so the UUID has to ' +
        'come from the device documentation or from a scanner app. Nothing is decoded: the ' +
        'raw bytes are recorded so a parser can be written against them afterwards.',
    )
    if (!uuid?.trim()) return
    setError(null)
    try {
      await manager.captureUnknown(uuid.trim().toLowerCase())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const downloadTrace = () => {
    const trace = manager.trace.toTrace(window.prompt('Note for this trace (optional)') ?? undefined)
    const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ble-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sensors</h2>

        {!supported && (
          <p className="banner error">
            This browser has no Web Bluetooth. Use Chrome, Edge or Opera on desktop or Android — Safari and
            Firefox do not implement it. The simulator below works anywhere.
          </p>
        )}
        {error && <p className="banner error">{error}</p>}

        <BluetoothChooser
          devices={chooser.devices}
          scanning={chooser.scanning}
          onPick={chooser.pick}
          onCancel={() => {
            chooser.cancel()
            setConnecting(null)
          }}
        />

        <div className="sensor-buttons">
          {SENSOR_PROFILES.map((profile) => (
            <button key={profile.key} disabled={!supported || connecting !== null} onClick={() => add(profile)}>
              <strong>{connecting === profile.key ? 'Pairing…' : profile.label}</strong>
              <span>{profile.hint}</span>
            </button>
          ))}
          <button className="dashed" onClick={addSimulator}>
            <strong>Simulator</strong>
            <span>Fake trainer and athlete, no hardware</span>
          </button>
        </div>

        <h3>Raw capture</h3>
        <p className="muted small">
          Records the bytes a sensor sends, without interpreting them. This is how a parser gets
          written for hardware whose protocol is not published, and how a change to an existing
          parser gets checked against packets a real device actually sent rather than against
          synthetic ones.
        </p>
        <div className="row">
          <button
            className="ghost"
            onClick={() => (manager.trace.isRecording ? manager.trace.stop() : manager.trace.start())}
          >
            {manager.trace.isRecording ? 'Stop capture' : 'Start capture'}
          </button>
          <button className="ghost" disabled={!supported} onClick={() => void captureUnknown()}>
            Capture an unknown device
          </button>
          <button className="ghost" disabled={manager.trace.size === 0} onClick={downloadTrace}>
            Save trace
          </button>
          <span className="muted small nowrap">{manager.trace.size} packets</span>
        </div>

        <h3>Connected</h3>
        {devices.length === 0 ? (
          <p className="muted">Nothing paired yet.</p>
        ) : (
          <table className="devices">
            <thead>
              <tr>
                <th>Device</th>
                <th>Role</th>
                <th>Providing</th>
                <th>Battery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <span className={`dot ${device.state}`} /> {device.name}
                  </td>
                  <td>{device.kind}</td>
                  <td className="muted small">
                    {device.provides
                      .filter((metric) => manager.sourceFor(metric)?.id === device.id)
                      .map((metric) => metricLabel(metric))
                      .join(', ') || '—'}
                  </td>
                  <td>{device.batteryPct != null ? `${device.batteryPct}%` : '—'}</td>
                  <td>
                    {device.state !== 'connected' && (
                      <button
                        className="ghost"
                        onClick={() => manager.retry(device.id)}
                        disabled={device.state === 'reconnecting'}
                        title="Try this device again now, without waiting for the next backoff"
                      >
                        {device.state === 'reconnecting' ? 'Reconnecting…' : 'Retry'}
                      </button>
                    )}
                    <button className="ghost" onClick={() => manager.remove(device.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {devices.length > 1 && (
          <>
            <h3>Preferred source</h3>
            <p className="muted small">
              When two devices report the same metric, a dedicated sensor wins by default. Override it here.
            </p>
            <div className="source-grid">
              {SOURCE_METRICS.map(({ key, label }) => {
                const candidates = devices.filter((d) => d.provides.includes(key))
                if (candidates.length < 2) return null
                return (
                  <label key={key}>
                    {label}
                    <select
                      value={manager.getPreferredSource(key) ?? ''}
                      onChange={(e) => manager.setPreferredSource(key, e.target.value || null)}
                    >
                      <option value="">Automatic</option>
                      {candidates.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </div>
          </>
        )}

        <h3>Live</h3>
        <div className="live-strip">
          <span>{metrics.power != null ? `${Math.round(metrics.power)} W` : '— W'}</span>
          <span>{metrics.heartRate != null ? `${metrics.heartRate} bpm` : '— bpm'}</span>
          <span>{metrics.cadence != null ? `${metrics.cadence} rpm` : '— rpm'}</span>
          <span>{metrics.speedMs != null ? `${(metrics.speedMs * 3.6).toFixed(1)} km/h` : '— km/h'}</span>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
