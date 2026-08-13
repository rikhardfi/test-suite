import { useCallback, useEffect, useMemo, useState } from 'react'
import { LactateChart } from './LactateChart'
import { MmpCurve } from './MmpCurve'
import { COLORS } from './theme'
import { formatClock, mmpCurve, normalizedPower, paceFromSpeed } from '../model/metrics'
import { analyseLactate, criticalPower, type LactatePoint } from '../model/analysis'
import { lapsFromSamples, type LactateEntry, type SessionRecord } from '../model/session'
import type { Protocol } from '../model/protocol'
import type { Recorder } from '../model/recorder'
import type { SessionSummary } from '../model/journal'
import {
  download,
  downloadBytes,
  lapsToCsv,
  samplesToCsv,
  sessionFilename,
  sessionToJson,
} from '../model/export'
import { fitFilename, sessionToFit } from '../model/fit'
import { pseudonymise, researchSidecar } from '../model/research'
import { APP_VERSION } from '../model/version'

export function Analysis({
  protocols,
  recorder,
  salt,
  onResume,
}: {
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

  const thresholds = useMemo(() => analyseLactate(points), [points])
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
          <button onClick={() => download(sessionFilename(session, 'csv'), samplesToCsv(session), 'text/csv')}>
            Samples CSV
          </button>
          <button
            title="Pseudonymised 1 Hz CSV plus a sidecar describing every column, the equations used and the protocol as actually executed"
            onClick={() => {
              // Pseudonymised, because this is the export that leaves the
              // machine. The name stays here; the code goes with the data.
              const anonymous = pseudonymise(session, salt)
              download(sessionFilename(anonymous, 'research.csv'), samplesToCsv(anonymous), 'text/csv')
              download(
                sessionFilename(anonymous, 'research.json'),
                researchSidecar(anonymous, { appVersion: APP_VERSION, protocol: protocol ?? undefined }),
                'application/json',
              )
            }}
          >
            Research export
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
                <th>HR</th>
                <th>La</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((result) => (
                <tr key={result.method} className={result.intensity == null ? 'muted' : ''}>
                  <td title={result.note}>{result.label}</td>
                  <td>{fmtIntensity(result.intensity)}</td>
                  <td>{result.heartRate ?? '—'}</td>
                  <td>{result.lactate != null ? result.lactate.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <MmpCurve series={[{ label: 'This session', color: COLORS.power, points: curve }]} />
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
      lactate: session.lactate.find((l) => l.stepIndex === stepIndex)?.mmol,
    }
  })
}
