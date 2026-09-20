import { useState } from 'react'
import { SENSOR_PROFILES, isWebBluetoothAvailable, type SensorManager, type SensorProfile } from '../ble/manager'
import { Simulator } from '../ble/simulator'
import { BluetoothChooser, useBluetoothChooser } from './BluetoothChooser'
import { useLiveMetrics, useSensorDevices } from './hooks'
import { metricLabel } from '../ble/metrics'
import type { MetricKey, SensorDevice } from '../ble/types'
import { Modal } from './Modal'
import { describeProbe, type TrainerResponse } from '../ble/probe'
import { FlowMeterSection } from './FlowMeterSection'


/**
 * What the link has been doing, when there is anything to say about it.
 *
 * A sensor that drops and comes back leaves no trace in the device row: the dot
 * goes amber for a second or two and then green again, and a meter that did
 * that forty times over a test looks identical to one that never moved. The
 * count is the only thing that tells those apart, and it is the difference
 * between a battery to change and a test to trust.
 */
function describeLink(device: SensorDevice): string {
  const parts: string[] = []
  if (device.state === 'reconnecting') {
    const attempts = device.reconnectAttempts ?? 0
    parts.push(attempts > 1 ? `Reconnecting, attempt ${attempts}` : 'Reconnecting')
  } else if (device.state === 'disconnected') {
    parts.push('Gave up; retry to try again')
  }
  if (device.drops) parts.push(device.drops === 1 ? '1 dropout' : `${device.drops} dropouts`)
  return parts.join(' · ')
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
  /** How many sensors were paired last time, so the offer can name a number. */
  rememberedCount: number
  onReconnectRemembered: () => void
  /** Last ERG probe, or null if none has been run on this machine today. */
  probe: TrainerResponse | null
  probing: boolean
  onProbe: () => void
  correcting: boolean
  onCorrectingChange: (enabled: boolean) => void
  onClose: () => void
}

export function SensorPanel({
  manager,
  ftpWatts,
  rememberedCount,
  onReconnectRemembered,
  probe,
  probing,
  onProbe,
  correcting,
  onCorrectingChange,
  onClose,
}: Props) {
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

  const addSimulator = (withMeter: boolean) => {
    if (devices.some((d) => d.id === 'sim:trainer')) return
    const simulator = new Simulator(manager, {
      ftpWatts,
      // The paired-meter variant reproduces a measured failure rather than an
      // invented one, so the correction can be watched doing its job with no
      // hardware in the room.
      referenceMeter: withMeter ? {} : undefined,
    })
    manager.addVirtual(simulator)
    simulator.attachReferenceMeter()
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
    <Modal onClose={close}>
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

        {rememberedCount > 0 && devices.length === 0 && (
          <div className="row">
            <button className="primary" onClick={onReconnectRemembered}>
              Reconnect {rememberedCount} sensor{rememberedCount === 1 ? '' : 's'} from last time
            </button>
            <span className="muted small">
              Only devices this machine has already been granted access to.
            </span>
          </div>
        )}

        <div className="sensor-buttons">
          {SENSOR_PROFILES.map((profile) => (
            <button key={profile.key} disabled={!supported || connecting !== null} onClick={() => add(profile)}>
              <strong>{connecting === profile.key ? 'Pairing…' : profile.label}</strong>
              <span>{profile.hint}</span>
            </button>
          ))}
          <button className="dashed" onClick={() => addSimulator(false)}>
            <strong>Simulator</strong>
            <span>Fake trainer and athlete, no hardware</span>
          </button>
          <button className="dashed" onClick={() => addSimulator(true)}>
            <strong>Simulator + power meter</strong>
            <span>Two power sources that disagree and drift, as a real pair does</span>
          </button>
        </div>

        <FlowMeterSection manager={manager} />

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
              {devices.map((device) => {
                const link = describeLink(device)
                return (
                <tr key={device.id}>
                  <td>
                    <span className={`dot ${device.state}`} /> {device.name}
                    {link && <div className="muted small">{link}</div>}
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
                        // Live while it is reconnecting too. That is the state a
                        // dropped sensor spends all its time in, and it is
                        // exactly when the operator wants the wait cut short.
                        title="Try this device again now, without waiting for the next backoff"
                      >
                        Retry now
                      </button>
                    )}
                    <button
                      className="ghost"
                      // A wired device has a connection of its own to close; the
                      // manager only knows how to let go of Bluetooth ones.
                      onClick={() => (device.kind === 'flowMeter' ? device.disconnect() : manager.remove(device.id))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                )
              })}
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

        <PowerSourcesSection
          manager={manager}
          probe={probe}
          probing={probing}
          onProbe={onProbe}
          correcting={correcting}
          onCorrectingChange={onCorrectingChange}
        />

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
    </Modal>
  )
}

/**
 * Which device is being trusted, which is being corrected, and by how much.
 *
 * A trainer in ERG holds its own measurement at the commanded number, which is
 * not the same quantity as the power going through the pedals, and the gap
 * between them moves as the unit warms. Pairing a second meter is what makes
 * that visible; the probe is what measures it; the switch is what acts on it.
 *
 * The switch is off by default and the panel says why. With one power source
 * there is nothing to correct against, and a correction driven by a meter
 * nobody has checked simply imposes that meter's error on the athlete.
 */
function PowerSourcesSection({
  manager,
  probe,
  probing,
  onProbe,
  correcting,
  onCorrectingChange,
}: {
  manager: SensorManager
  probe: TrainerResponse | null
  probing: boolean
  onProbe: () => void
  correcting: boolean
  onCorrectingChange: (enabled: boolean) => void
}) {
  const pair = manager.powerPair()
  const machine = manager.machine
  if (!pair.reference && !machine) return null

  return (
    <>
      <h3>Power sources</h3>
      <div className="source-roles">
        <p className="small">
          Reported and corrected against:{' '}
          <strong>{pair.reference?.name ?? 'nothing reporting'}</strong>
        </p>
        <p className="small">
          Machine's own reading:{' '}
          <strong>{pair.machine?.name ?? 'not separately reported'}</strong>
        </p>
        {!pair.machine && machine && (
          <p className="muted small">
            Only one device is reporting power, so the trainer is being compared with itself. Pair a
            power meter to see what the athlete is actually producing.
          </p>
        )}
      </div>

      <div className="row">
        <button className="ghost" disabled={!machine || probing} onClick={onProbe}>
          {probing ? 'Probing…' : 'Probe ERG (30 s)'}
        </button>
        <label className="check small">
          <input
            type="checkbox"
            checked={correcting}
            disabled={!pair.machine}
            onChange={(e) => onCorrectingChange(e.target.checked)}
          />
          Command the trainer so the meter reads the target
        </label>
      </div>

      {probe && (
        <p className={`small ${probe.ok ? 'muted' : 'banner error'}`}>{describeProbe(probe)}</p>
      )}
      <p className="muted small">
        The athlete has to be pedalling steadily for the probe to mean anything. It commands 100 W
        then 180 W and measures what arrives, so run it in the warm-up rather than at the start line.
      </p>
    </>
  )
}
