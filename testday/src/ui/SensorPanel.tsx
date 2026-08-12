import { useState } from 'react'
import { SENSOR_PROFILES, isWebBluetoothAvailable, type SensorManager, type SensorProfile } from '../ble/manager'
import { Simulator } from '../ble/simulator'
import { useLiveMetrics, useSensorDevices } from './hooks'
import type { MetricKey } from '../ble/types'

const METRIC_LABELS: Record<MetricKey, string> = {
  power: 'power',
  heartRate: 'heart rate',
  cadence: 'cadence',
  speedMs: 'speed',
  distanceM: 'distance',
  inclinePct: 'incline',
  resistance: 'resistance',
}

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

  const addSimulator = () => {
    if (devices.some((d) => d.id === 'sim:trainer')) return
    const simulator = new Simulator(manager, { ftpWatts })
    manager.addVirtual(simulator)
    void simulator.start()
  }

  const supported = isWebBluetoothAvailable()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sensors</h2>

        {!supported && (
          <p className="banner error">
            This browser has no Web Bluetooth. Use Chrome, Edge or Opera on desktop or Android — Safari and
            Firefox do not implement it. The simulator below works anywhere.
          </p>
        )}
        {error && <p className="banner error">{error}</p>}

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
                      .map((metric) => METRIC_LABELS[metric])
                      .join(', ') || '—'}
                  </td>
                  <td>{device.batteryPct != null ? `${device.batteryPct}%` : '—'}</td>
                  <td>
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
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
