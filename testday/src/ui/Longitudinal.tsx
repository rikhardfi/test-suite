import { useEffect, useMemo, useState } from 'react'
import { COLORS } from './theme'
import { useCanvas } from './hooks'
import { athleteKey, judgeTrend, summariseSession, trendFor, type SessionThresholds } from '../model/longitudinal'
import { curveSamples } from '../model/analysis'
import type { Protocol } from '../model/protocol'
import type { Recorder } from '../model/recorder'

/**
 * One athlete across test days.
 *
 * The single-session view answers "what happened today". This answers the
 * question that actually gets asked, which is whether today is different from
 * last time. Athletes sit systematically above population reference ranges, so
 * a value comfortably inside the normal range can already be a decline, and
 * nothing but the same athlete measured before will show it.
 */
export function Longitudinal({
  recorder,
  protocols,
  onClose,
}: {
  recorder: Recorder
  protocols: Protocol[]
  onClose: () => void
}) {
  const [sessions, setSessions] = useState<SessionThresholds[] | null>(null)
  const [athletes, setAthletes] = useState<string[]>([])
  const [athlete, setAthlete] = useState<string | null>(null)
  const [method, setMethod] = useState('modifiedDmax')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const summaries = await recorder.list()
      const byAthlete = new Map<string, SessionThresholds[]>()
      for (const summary of summaries) {
        const session = await recorder.read(summary.id)
        if (!session) continue
        const key = athleteKey(session)
        const list = byAthlete.get(key) ?? []
        list.push(summariseSession(session, protocols))
        byAthlete.set(key, list)
      }
      if (cancelled) return
      const names = [...byAthlete.keys()].sort()
      setAthletes(names)
      const chosen = names[0] ?? null
      setAthlete(chosen)
      setSessions(chosen ? (byAthlete.get(chosen) ?? []) : [])
      // Held so switching athlete does not re-read every journal.
      cache.current = byAthlete
    })()
    return () => {
      cancelled = true
    }
  }, [recorder, protocols])

  const cache = useMemo(() => ({ current: new Map<string, SessionThresholds[]>() }), [])

  const forAthlete = useMemo(
    () =>
      [...(sessions ?? [])]
        .filter((s) => s.points.length > 0)
        .sort((a, b) => a.startedAt - b.startedAt),
    [sessions],
  )

  const methods = useMemo(() => {
    const seen = new Map<string, string>()
    for (const session of forAthlete) {
      for (const threshold of session.thresholds) {
        if (threshold.intensity != null) seen.set(threshold.method, threshold.label)
      }
    }
    return [...seen.entries()]
  }, [forAthlete])

  const trend = useMemo(() => trendFor(forAthlete, method), [forAthlete, method])
  const verdict = useMemo(() => judgeTrend(trend), [trend])

  return (
    <div className="page">
      <div className="page-head">
        <h1>Across test days</h1>
        <button className="ghost" onClick={onClose}>
          Back to sessions
        </button>
      </div>

      {sessions === null && <p className="muted">Reading sessions…</p>}

      {sessions !== null && forAthlete.length === 0 && (
        <p className="muted">
          No sessions with lactate values yet. A history needs at least one test with blood samples
          in it.
        </p>
      )}

      {forAthlete.length > 0 && (
        <>
          <div className="row">
            <label>
              Athlete
              <select
                value={athlete ?? ''}
                onChange={(e) => {
                  setAthlete(e.target.value)
                  setSessions(cache.current.get(e.target.value) ?? [])
                }}
              >
                {athletes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Method
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {methods.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">
              {forAthlete.length} test{forAthlete.length === 1 ? '' : 's'} with lactate
            </span>
          </div>

          {verdict && (
            <p className={verdict.changed ? 'banner' : 'banner muted'}>{verdict.summary}</p>
          )}

          <section className="panel">
            <div className="panel-head">
              <span className="muted">Lactate curves, oldest lightest</span>
            </div>
            <LactateOverlay sessions={forAthlete} />
          </section>

          <section className="panel pad">
            <h2>Threshold by test day</h2>
            <p className="muted small">
              The bar is the leave-one-out range: what the estimate becomes if any single blood
              sample is dropped. A change smaller than the bars is not a change.
            </p>
            <table className="devices">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Protocol</th>
                  <th>Estimate</th>
                  <th>If one point is dropped</th>
                  <th>Conditions</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((point) => {
                  const session = forAthlete.find((s) => s.sessionId === point.sessionId)
                  return (
                    <tr key={point.sessionId}>
                      <td>{new Date(point.startedAt).toLocaleDateString()}</td>
                      <td className="muted small">{session?.protocolName}</td>
                      <td>{point.intensity.toFixed(0)}</td>
                      <td className={point.unstable ? 'warn small' : 'muted small'}>
                        {point.low != null && point.high != null
                          ? `${point.low.toFixed(0)} to ${point.high.toFixed(0)}`
                          : 'not enough points to say'}
                      </td>
                      <td className="muted small">{conditions(session)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}

/** Conditions matter to how a result reads, so they sit next to it. */
function conditions(session?: SessionThresholds): string {
  const environment = session?.environment
  if (!environment) return '—'
  const parts: string[] = []
  if (environment.tempC != null) parts.push(`${environment.tempC.toFixed(0)} °C`)
  if (environment.humidityPct != null) parts.push(`${environment.humidityPct.toFixed(0)}% RH`)
  if (environment.co2Ppm != null) parts.push(`${environment.co2Ppm.toFixed(0)} ppm`)
  return parts.join(' · ') || '—'
}

/** Every test day's lactate curve on one pair of axes, newest most prominent. */
function LactateOverlay({ sessions }: { sessions: SessionThresholds[] }) {
  const ref = useCanvas(
    (ctx, width, height) => {
      const points = sessions.flatMap((s) => s.points)
      if (points.length === 0) return

      const padding = { left: 46, right: 12, top: 12, bottom: 28 }
      const minX = Math.min(...points.map((p) => p.intensity))
      const maxX = Math.max(...points.map((p) => p.intensity))
      const maxY = Math.max(8, Math.max(...points.map((p) => p.lactate)))

      const x = (value: number) =>
        padding.left + ((value - minX) / Math.max(1, maxX - minX)) * (width - padding.left - padding.right)
      const y = (value: number) =>
        height - padding.bottom - (value / maxY) * (height - padding.top - padding.bottom)

      ctx.strokeStyle = COLORS.grid ?? '#2a3450'
      ctx.lineWidth = 1
      for (const level of [2, 4]) {
        ctx.beginPath()
        ctx.moveTo(padding.left, y(level))
        ctx.lineTo(width - padding.right, y(level))
        ctx.stroke()
        ctx.fillStyle = COLORS.muted
        ctx.font = '10px system-ui'
        ctx.fillText(`${level} mmol/L`, padding.left + 4, y(level) - 3)
      }

      sessions.forEach((session, index) => {
        // Oldest faintest, so the eye lands on the most recent test.
        const weight = (index + 1) / sessions.length
        ctx.globalAlpha = 0.25 + 0.75 * weight
        ctx.strokeStyle = COLORS.lactate ?? '#ff65e6'
        ctx.fillStyle = ctx.strokeStyle
        ctx.lineWidth = index === sessions.length - 1 ? 2 : 1

        const curve = curveSamples(session.points, 60)
        if (curve.length) {
          ctx.beginPath()
          curve.forEach((point, i) => {
            const px = x(point.intensity)
            const py = y(point.lactate)
            if (i === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          })
          ctx.stroke()
        }

        for (const point of session.points) {
          ctx.beginPath()
          ctx.arc(x(point.intensity), y(point.lactate), 3, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      ctx.globalAlpha = 1
    },
    [sessions],
  )

  return <canvas ref={ref} className="chart" />
}
