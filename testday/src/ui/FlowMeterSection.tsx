import { useEffect, useState } from 'react'
import { FLOW_METER_ID, FlowMeterDevice } from '../ble/flowMeter'
import type { SensorManager } from '../ble/manager'
import type { FlowMeterStatus } from '../model/flow'
import { isDesktop } from '../model/recorder.create'
import { useSensorDevices } from './hooks'

const RATES_MS = [1, 2, 5, 10, 20, 50, 100]
const DEFAULT_RATE_MS = 10

const fmt = (value: number | null, digits: number, unit: string) =>
  value == null ? `— ${unit}` : `${value.toFixed(digits)} ${unit}`

/**
 * The TSI flow meter: a wired device on the expiratory limb, so it has its own
 * section rather than a Bluetooth button. Connect, choose the rate, and the two
 * operations the meter needs during a test day: zeroing the circuit pressure
 * and starting the volume count from zero.
 */
export function FlowMeterSection({ manager }: { manager: SensorManager }) {
  const devices = useSensorDevices(manager)
  const device = devices.find((d) => d.id === FLOW_METER_ID) as FlowMeterDevice | undefined
  const [status, setStatus] = useState<FlowMeterStatus | null>(device?.status ?? null)
  const [host, setHost] = useState('')
  const [rateMs, setRateMs] = useState(device?.status?.rateMs ?? DEFAULT_RATE_MS)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!device) return
    setStatus(device.status)
    return device.onChange(setStatus)
  }, [device])

  const act = async (label: string, task: () => Promise<unknown>) => {
    setError(null)
    setNote(null)
    setBusy(label)
    try {
      await task()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(null)
    }
  }

  const connect = () =>
    act('connect', async () => {
      const meter = new FlowMeterDevice(manager)
      await meter.start({ host: host.trim() || undefined, rateMs })
    })

  const zero = () => {
    const sure = window.confirm(
      'Zero the circuit pressure?\n\nOnly with no flow through the meter and its pressure ports open ' +
        'to the room. Streaming pauses for about half a second, and the zero is noted in the session.',
    )
    if (!sure || !device) return
    void act('zero', async () => {
      const result = await device.zero()
      if (!result.ok) throw new Error(result.detail ?? 'The meter refused to zero')
      setNote('Circuit pressure zeroed.')
    })
  }

  const resetTotal = () => {
    if (!device) return
    void act('reset', async () => {
      const result = await device.resetTotal()
      if (!result.ok) throw new Error(result.detail ?? 'The meter refused the reset')
      setNote('Volume count restarted from zero.')
    })
  }

  const changeRate = (ms: number) => {
    setRateMs(ms)
    if (!device) return
    void act('rate', async () => {
      const result = await device.setRate(ms)
      if (!result.ok) throw new Error(result.detail ?? 'The meter refused the rate')
    })
  }

  const connected = status?.state === 'connected'

  return (
    <>
      <h3>TSI flow meter</h3>
      {!isDesktop() ? (
        <p className="muted small">Needs the desktop app: a browser cannot open the meter's connection.</p>
      ) : (
        <>
          <div className="row">
            {!device && (
              <input
                type="text"
                placeholder="Address (found automatically)"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                aria-label="Flow meter address"
              />
            )}
            <label className="small">
              Sample every{' '}
              <select
                value={status?.rateMs ?? rateMs}
                disabled={busy !== null || (device != null && !connected)}
                onChange={(e) => (device ? changeRate(Number(e.target.value)) : setRateMs(Number(e.target.value)))}
              >
                {RATES_MS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms} ms
                  </option>
                ))}
              </select>
            </label>
            {device ? (
              <>
                <button className="ghost" disabled={!connected || busy !== null} onClick={zero}>
                  {busy === 'zero' ? 'Zeroing…' : 'Zero pressure'}
                </button>
                <button className="ghost" disabled={!connected || busy !== null} onClick={resetTotal}>
                  {busy === 'reset' ? 'Resetting…' : 'Reset volume'}
                </button>
                <button className="ghost" disabled={busy !== null} onClick={() => device.disconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button disabled={busy !== null} onClick={() => void connect()}>
                {busy === 'connect' ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>

          {error && <p className="banner error">{error}</p>}
          {note && <p className="muted small">{note}</p>}

          {device && status && (
            <>
              <p className="small">
                <span className={`dot ${status.state}`} /> {device.name}
                {status.host ? ` at ${status.host}` : ''} · {status.state}
                {status.error && status.state !== 'connected' ? ` · ${status.error}` : ''}
              </p>
              <div className="live-strip">
                <span>{fmt(status.flowLMin, 2, 'L/min')}</span>
                <span>{fmt(status.tempC, 1, '°C')}</span>
                <span>{fmt(status.humidityPct, 1, '%RH')}</span>
                <span>{fmt(status.totalL, 2, 'L')}</span>
                <span>{fmt(status.lowPressureCmH2O, 2, 'cmH₂O')}</span>
              </div>
              {status.humiditySaturated && (
                <p className="banner error">
                  Humidity reads 100 %: water is condensing in the tubing or on the sensor. RH and the water
                  content derived from it are not valid until it clears.
                </p>
              )}
              {status.meter && !status.meter.directionSensor && (
                <p className="muted small">
                  One-way: the direction sensor is off, so any reverse flow reads as positive.
                </p>
              )}
              <p className="muted small">
                {status.rows.toLocaleString()} rows · the meter restarts its stream every 30 s, losing{' '}
                {status.lastGapMs != null ? `${Math.round(status.lastGapMs)} ms` : 'about 0.1 s'}{' '}
                each time ({status.gaps} so far). Every gap and the volume that passed in it are recorded.
              </p>
            </>
          )}
        </>
      )}
    </>
  )
}
