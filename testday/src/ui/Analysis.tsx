import { useCallback, useEffect, useMemo, useState } from 'react'
import { LactateChart } from './LactateChart'
import { DurationCurve } from './DurationCurve'
import { COLORS } from './theme'
import { formatClock, mmpCurve, normalizedPower, paceFromSpeed } from '../model/metrics'
import { analyseLactateWithBands, criticalPower, type LactatePoint } from '../model/analysis'
import { lapsFromSamples, type LactateEntry, type SessionRecord } from '../model/session'
import type { Protocol } from '../model/protocol'
import type { Recorder } from '../model/recorder'
import type { SessionSummary } from '../model/journal'
import {
  download,
  downloadBytes,
  downloadParts,
  lapsToCsv,
  samplesToCsv,
  sessionFilename,
  sessionToJson,
} from '../model/export'
import { fitFilename, sessionToFit } from '../model/fit'
import { pseudonymise, researchSidecar } from '../model/research'
import type { FlowRecord } from '../model/flow'
import { flowRows, flowSidecar, withExhaled } from '../model/flowExport'
import { buildResearchGrid } from '../model/researchGrid'
import { parseCartCsv, ventilatoryThresholds, type VentilatoryResult } from '../model/ventilatory'
import { APP_VERSION } from '../model/version'

export function Analysis({
  protocols,
  recorder,
  salt,
  onOpenHistory,
  onResume,
}: {
  onOpenHistory: () => void
  protocols: Protocol[]
  recorder: Recorder
  /** Machine-local salt for the participant code. Never leaves this machine. */
  salt: string
  /** Reopens a session for recording, finished or not. */
  onResume: (summary: SessionSummary) => void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [session, setSession] = useState<SessionRecord | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const all = await recorder.list()
      setSessions(all)
      setSelectedId((current) => current ?? all[0]?.id ?? null)
    } finally {
      setLoading(false)
    }
  }, [recorder])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Only the selected session's samples are read, so the list stays cheap on a
  // machine that has recorded a whole season.
  useEffect(() => {
    let cancelled = false
    if (!selectedId) {
      setSession(null)
      return
    }
    void recorder.read(selectedId).then((loaded) => {
      if (!cancelled) setSession(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId, recorder])

  return (
    <div className="page analysis">
      <aside className="session-list">
        <h1>Sessions</h1>
        <button
          className="ghost"
          onClick={onOpenHistory}
          title="Compare this athlete's test days against each other rather than against a population"
        >
          Across test days
        </button>
        {loading && <p className="muted">Loading…</p>}
        {!loading && sessions.length === 0 && <p className="muted">No saved sessions yet.</p>}
        <ul>
          {sessions.map((item) => (
            <li key={item.id}>
              <button className={item.id === selectedId ? 'on' : ''} onClick={() => setSelectedId(item.id)}>
                <strong>{item.protocolName}</strong>
                <span className="muted small">
                  {new Date(item.startedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                  {' · '}
                  {formatClock(item.sampleCount)}
                  {item.lactateCount ? ` · ${item.lactateCount} La` : ''}
                  {item.closed ? '' : ' · interrupted'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {session ? (
        <SessionDetail
          key={session.id}
          session={session}
          protocols={protocols}
          salt={salt}
          onResume={() => {
            const summary = sessions.find((s) => s.id === session.id)
            if (summary) onResume(summary)
          }}
          onLactate={async (entry) => {
            const updated = await recorder.amendLactate(session.id, entry)
            if (updated) setSession(updated)
            await refresh()
          }}
          onDelete={async () => {
            await recorder.discard(session.id)
            setSelectedId(null)
            setSession(null)
            await refresh()
          }}
        />
      ) : (
        <div className="empty">Select a session.</div>
      )}
    </div>
  )
}

function SessionDetail({
  session,
  protocols,
  salt,
  onLactate,
  onResume,
  onDelete,
}: {
  session: SessionRecord
  protocols: Protocol[]
  salt: string
  onLactate: (entry: LactateEntry) => void | Promise<void>
  onResume: () => void
  onDelete: () => void
}) {
  const isRun = session.sport === 'run'
  const protocol = protocols.find((p) => p.id === session.protocolId)

  // The flow meter's recording lives beside the journal, not in the session
  // record, and is read only when this session is opened. Null means none.
  const [flow, setFlow] = useState<FlowRecord[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setFlow(null)
    void window.testday?.flowRead(session.id).then((records) => {
      if (!cancelled) setFlow(records && records.length ? records : null)
    })
    return () => {
      cancelled = true
    }
  }, [session.id])
  const rows = useMemo(() => (flow ? flowRows(flow) : []), [flow])
  const exported = useMemo(() => withExhaled(session, rows), [session, rows])
  const [exporting, setExporting] = useState(false)

  const laps = useMemo(
    () =>
      protocol
        ? lapsFromSamples(session.samples, protocol, session.athlete, session.lactate)
        : // The protocol may have been deleted or edited since; fall back to
          // whatever step structure the samples themselves carry.
          syntheticLaps(session),
    [session, protocol],
  )

  const points = useMemo<LactatePoint[]>(
    () =>
      session.lactate
        .flatMap<LactatePoint>((entry) => {
          const lap = laps[entry.stepIndex]
          const intensity = isRun
            ? lap?.avgSpeedMs
              ? lap.avgSpeedMs * 3.6
              : null
            : (lap?.avgPower ?? lap?.targetWatts ?? null)
          if (intensity == null) return []
          return [
            {
              intensity,
              lactate: entry.mmol,
              heartRate: entry.heartRate ?? lap?.avgHeartRate ?? undefined,
            },
          ]
        }),
    [session.lactate, laps, isRun],
  )

  const thresholds = useMemo(() => analyseLactateWithBands(points), [points])

  /**
   * Ventilatory thresholds imported from a metabolic cart, placed beside the
   * lactate ones. This is also the only route by which the app's own VO₂
   * estimates ever get checked against a measurement.
   */
  const [cart, setCart] = useState<{ result: VentilatoryResult; file: string; matched: string[] } | null>(
    null,
  )

  const importCart = async (file: File) => {
    const parsed = parseCartCsv(await file.text())
    setCart({
      result: ventilatoryThresholds(parsed.samples),
      file: file.name,
      matched: Object.values(parsed.matched),
    })
  }
  const power = useMemo(() => session.samples.map((s) => s.power ?? 0), [session.samples])
  const curve = useMemo(() => mmpCurve(power), [power])
  const cp = useMemo(() => criticalPower(curve), [curve])
  const np = useMemo(() => normalizedPower(power), [power])

  const unit = isRun ? 'km/h' : 'watts'
  const fmtIntensity = (value: number | null) =>
    value == null ? '—' : isRun ? `${value.toFixed(2)} km/h · ${paceFromSpeed(value / 3.6)}/km` : `${Math.round(value)} W`

  return (
    <div className="detail">
      <div className="page-head">
        <div>
          <h1>{session.protocolName}</h1>
          <p className="muted small">
            {session.athlete.name} · {new Date(session.startedAt).toLocaleString()} ·{' '}
            {formatClock(session.samples.length)} recorded
          </p>
        </div>
        <div className="row">
          {/* Any session can be reopened, finished or interrupted. */}
          <button className="primary" onClick={onResume} title="Reopen this session and record into it again">
            Resume
          </button>
          <button onClick={() => download(sessionFilename(session, 'csv'), samplesToCsv(exported), 'text/csv')}>
            Samples CSV
          </button>
          <button
            title="Pseudonymised CSV on one time grid at the rate of the fastest device, plus a sidecar describing every column, where each came from, the equations used and the protocol as actually executed"
            disabled={exporting}
            onClick={() => {
              setExporting(true)
              void (async () => {
                try {
                  // Pseudonymised, because this is the export that leaves the
                  // machine. The name stays here; the code goes with the data.
                  const anonymous = pseudonymise(session, salt)
                  const raw = (await window.testday?.rawRead(session.id)) ?? []
                  const grid = buildResearchGrid(anonymous, raw, flow)
                  downloadParts(sessionFilename(anonymous, 'research.csv'), grid.csvParts, 'text/csv')
                  download(
                    sessionFilename(anonymous, 'research.json'),
                    researchSidecar(anonymous, {
                      appVersion: APP_VERSION,
                      protocol: protocol ?? undefined,
                      flow: flow ? flowSidecar(flow, rows) : undefined,
                      grid,
                    }),
                    'application/json',
                  )
                } finally {
                  setExporting(false)
                }
              })()
            }}
          >
            {exporting ? 'Exporting…' : 'Research export'}
          </button>
          <button onClick={() => download(sessionFilename(session, 'laps.csv'), lapsToCsv(laps), 'text/csv')}>
            Laps CSV
          </button>
          <button
            title="Activity file with laps per protocol step, and lactate, RPE, targets and the VO₂ estimate as developer fields"
            onClick={() =>
              downloadBytes(
                fitFilename(session),
                sessionToFit(session, { laps, protocol: protocol ?? undefined }),
                'application/vnd.ant.fit',
              )
            }
          >
            FIT
          </button>
          <button
            onClick={() => download(sessionFilename(session, 'json'), sessionToJson(session), 'application/json')}
          >
            JSON
          </button>
          {/* Nothing is unlinked: the session is moved aside and stays recoverable. */}
          <button className="ghost danger" onClick={onDelete} title="Moves the session out of this list. The files are kept.">
            Remove
          </button>
        </div>
      </div>

      <div className="analysis-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="muted">Lactate curve</span>
          </div>
          <LactateChart points={points} thresholds={thresholds} unit={unit} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="muted">Thresholds</span>
          </div>
          <table className="results">
            <thead>
              <tr>
                <th>Method</th>
                <th>{isRun ? 'Speed' : 'Power'}</th>
                <th title="What the estimate becomes if any one blood sample is dropped">
                  Drop one
                </th>
                <th>HR</th>
                <th>La</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((result) => (
                <tr key={result.method} className={result.intensity == null ? 'muted' : ''}>
                  <td title={result.note}>{result.label}</td>
                  <td>{fmtIntensity(result.intensity)}</td>
                  {/* A cubic through five noisy points gives six confident
                      decimals and says nothing about how wide the interval is.
                      This is the cheapest honest answer to that. */}
                  <td
                    className={result.unstable ? 'warn small' : 'muted small'}
                    title={result.reason}
                  >
                    {result.lowIntensity != null && result.highIntensity != null
                      ? `${fmtIntensity(result.lowIntensity)} to ${fmtIntensity(result.highIntensity)}`
                      : result.intensity != null
                        ? 'too few points'
                        : '—'}
                  </td>
                  <td>{result.heartRate ?? '—'}</td>
                  <td>{result.lactate != null ? result.lactate.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cart && (
            <div className="pad">
              <h3>Ventilatory thresholds</h3>
              <p className="muted small">
                From {cart.file}. Columns read: {cart.matched.join(', ') || 'none'}.
              </p>
              <table className="results">
                <tbody>
                  {cart.result.vt1 && (
                    <tr>
                      <td title={cart.result.vt1.note}>VT1 · {cart.result.vt1.method}</td>
                      <td>{cart.result.vt1.vo2?.toFixed(0) ?? '—'} mL/min</td>
                      <td>{cart.result.vt1.heartRate?.toFixed(0) ?? '—'} bpm</td>
                    </tr>
                  )}
                  {cart.result.vt2 && (
                    <tr>
                      <td title={cart.result.vt2.note}>VT2 · {cart.result.vt2.method}</td>
                      <td>{cart.result.vt2.vo2?.toFixed(0) ?? '—'} mL/min</td>
                      <td>{cart.result.vt2.heartRate?.toFixed(0) ?? '—'} bpm</td>
                    </tr>
                  )}
                </tbody>
              </table>
              {/* Said out loud rather than left as a blank row: an absent
                  threshold and a failed import look identical otherwise. */}
              {cart.result.problems.map((problem) => (
                <p key={problem} className="muted small">
                  {problem}
                </p>
              ))}
            </div>
          )}

          <div className="pad">
            <label className="check">
              <input
                type="file"
                accept=".csv,.txt,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void importCart(file)
                }}
              />
              Import a metabolic cart export to place VT1 and VT2 beside these
            </label>
          </div>

          {points.length < 4 && (
            <p className="muted small pad">
              Dmax and the log-log breakpoint need four or more lactate samples. Add them in the table below.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="muted">Mean-maximal power</span>
          </div>
          <DurationCurve
            series={[
              {
                label: 'This session',
                color: COLORS.power,
                points: curve.map((p) => ({ durationS: p.durationS, value: p.watts })),
              },
            ]}
          />
          <dl className="stats">
            <div>
              <dt>Critical power</dt>
              <dd>{cp ? `${Math.round(cp.cpWatts)} W` : '—'}</dd>
            </div>
            <div>
              <dt>W′</dt>
              <dd>{cp ? `${(cp.wPrimeJoules / 1000).toFixed(1)} kJ` : '—'}</dd>
            </div>
            <div>
              <dt>Fit r²</dt>
              <dd>{cp ? cp.r2.toFixed(3) : '—'}</dd>
            </div>
            <div>
              <dt>Normalised power</dt>
              <dd>{np ? `${Math.round(np)} W` : '—'}</dd>
            </div>
            <div>
              <dt>W/kg at CP</dt>
              <dd>{cp ? (cp.cpWatts / session.athlete.massKg).toFixed(2) : '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="panel span-2">
          <div className="panel-head">
            <span className="muted">Steps</span>
          </div>
          <div className="table-scroll">
            <table className="results">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Target</th>
                  <th>Avg power</th>
                  <th>{isRun ? 'Avg speed' : 'Avg cadence'}</th>
                  <th>Avg HR</th>
                  <th>Max HR</th>
                  <th>Lactate</th>
                </tr>
              </thead>
              <tbody>
                {laps.map((lap) => (
                  <tr key={lap.stepIndex}>
                    <td>{lap.name}</td>
                    <td>{lap.target}</td>
                    <td>{lap.avgPower != null ? `${lap.avgPower} W` : '—'}</td>
                    <td>
                      {isRun
                        ? lap.avgSpeedMs
                          ? `${(lap.avgSpeedMs * 3.6).toFixed(2)} km/h`
                          : '—'
                        : (lap.avgCadence ?? '—')}
                    </td>
                    <td>{lap.avgHeartRate ?? '—'}</td>
                    <td>{lap.maxHeartRate ?? '—'}</td>
                    <td>
                      <input
                        className="inline"
                        inputMode="decimal"
                        defaultValue={lap.lactate ?? ''}
                        placeholder="—"
                        onBlur={(event) => {
                          const raw = event.target.value.replace(',', '.').trim()
                          const value = Number(raw)
                          const cleared = raw === '' || !Number.isFinite(value) || value <= 0
                          const current = session.lactate.find((l) => l.stepIndex === lap.stepIndex)
                          // Nothing to record when an empty field is left empty.
                          if (cleared && !current) return
                          if (!cleared && current?.mmol === value) return
                          void onLactate(
                            cleared
                              ? { stepIndex: lap.stepIndex, mmol: 0, at: Date.now(), removed: true }
                              : {
                                  stepIndex: lap.stepIndex,
                                  mmol: value,
                                  heartRate: lap.avgHeartRate ?? undefined,
                                  at: Date.now(),
                                },
                          )
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

/** Step summaries derived from the recording alone, when the protocol is gone. */
function syntheticLaps(session: SessionRecord) {
  const indices = [...new Set(session.samples.map((s) => s.stepIndex))].sort((a, b) => a - b)
  return indices.map((stepIndex) => {
    const work = session.samples.filter((s) => s.stepIndex === stepIndex && s.phase === 'work')
    const avg = (pick: (s: (typeof work)[number]) => number | undefined) => {
      const values = work.map(pick).filter((v): v is number => v != null)
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
    }
    const maxOf = (pick: (s: (typeof work)[number]) => number | undefined) => {
      const values = work.map(pick).filter((v): v is number => v != null)
      return values.length ? Math.max(...values) : null
    }
    const target = work.find((s) => s.targetPower != null)?.targetPower ?? null
    const avgPower = avg((s) => s.power)
    const avgSpeed = avg((s) => s.speedMs)
    const powers = work.map((s) => s.power).filter((v): v is number => v != null)
    const distances = work.map((s) => s.distanceM).filter((v): v is number => v != null)
    const workJ = powers.reduce((a, b) => a + b, 0)
    const avgVo2 = avg((s) => s.vo2Est)
    const entry = session.lactate.find((l) => l.stepIndex === stepIndex)
    return {
      stepIndex,
      name: `Step ${stepIndex + 1}`,
      target: target != null ? `${target} W` : '—',
      targetWatts: target,
      durationS: work.length,
      avgPower: avgPower != null ? Math.round(avgPower) : null,
      maxPower: maxOf((s) => s.power),
      avgHeartRate: avg((s) => s.heartRate) != null ? Math.round(avg((s) => s.heartRate) as number) : null,
      maxHeartRate: maxOf((s) => s.heartRate),
      avgCadence: avg((s) => s.cadence) != null ? Math.round(avg((s) => s.cadence) as number) : null,
      avgSpeedMs: avgSpeed != null ? Number(avgSpeed.toFixed(2)) : null,
      distanceM: distances.length
        ? Number((distances[distances.length - 1] - distances[0]).toFixed(1))
        : null,
      normalizedPower: normalizedPower(powers),
      workKj: powers.length ? Number((workJ / 1000).toFixed(1)) : null,
      kcal: avgVo2 != null
        ? Math.round(((avgVo2 * session.athlete.massKg) / 1000) * 5 * (work.length / 60))
        : powers.length
          ? Math.round(workJ / 1000 / 4.184 / 0.22)
          : null,
      avgVo2: avgVo2 != null ? Number(avgVo2.toFixed(1)) : null,
      avgInclinePct: avg((s) => s.inclinePct),
      lactate: entry?.mmol,
      rpe: entry?.rpe,
    }
  })
}
