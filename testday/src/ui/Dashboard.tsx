import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { WorkoutGraph } from './WorkoutGraph'
import { MmpCurve, type CurveSeries } from './MmpCurve'
import { LapTable } from './LapTable'
import { COLORS } from './theme'
import { useHotkeys, useLiveMetrics, useRunnerSnapshot } from './hooks'
import { defaultFrontFor, tileByKey, tilesForSport, type TileContext, type TileTone } from './tiles'
import { formatClock, formatCountdown, mmpCurve } from '../model/metrics'
import { criticalPower } from '../model/analysis'
import { planPowerSeries, stepLabel, type Athlete, type Protocol } from '../model/protocol'
import { lapsFromSamples, type TestRunner } from '../model/session'
import type { RecorderStatus } from '../model/recorder'
import type { SensorManager } from '../ble/manager'

interface Props {
  runner: TestRunner
  protocol: Protocol
  athlete: Athlete
  manager: SensorManager
  bestCurve?: { durationS: number; watts: number }[]
  status: RecorderStatus
  /** How this build stores a recording, said plainly. */
  durability: string
  /** Tile keys on the front face, in order. Empty means the defaults. */
  frontTiles: string[]
  onOpenSensors: () => void
  onEditTiles: () => void
  onFinish: () => void
}

export function Dashboard({
  runner,
  protocol,
  athlete,
  manager,
  bestCurve,
  status,
  durability,
  frontTiles,
  onOpenSensors,
  onEditTiles,
  onFinish,
}: Props) {
  const snapshot = useRunnerSnapshot(runner)
  const metrics = useLiveMetrics(manager)
  const [lactate, setLactate] = useState<{ stepIndex: number; auto: boolean } | null>(null)
  const openLactate = (stepIndex: number) => setLactate({ stepIndex, auto: false })

  const [face, setFace] = useState<'front' | 'back'>('front')

  useHotkeys({
    ' ': () => runner.toggle(),
    ArrowRight: () => runner.nextStep(),
    ArrowLeft: () => runner.prevStep(),
    ArrowUp: () => runner.adjustIntensity(1),
    ArrowDown: () => runner.adjustIntensity(-1),
    l: () => openLactate(snapshot.stepIndex),
    f: () => setFace((current) => (current === 'front' ? 'back' : 'front')),
  })

  // Flip back when a new step starts, so nobody is caught reading the trivia
  // face at the moment the numbers that matter change.
  useEffect(() => {
    setFace('front')
  }, [snapshot.stepIndex])

  // Offer the lactate entry as soon as a sampling break opens, which is the
  // one moment the operator's hands are on the meter and not the keyboard.
  // An auto-opened dialog closes itself again when the break ends, so it never
  // covers the dashboard once the athlete is back on the pedals.
  const lastPrompted = useRef<number | null>(null)
  useEffect(() => {
    const step = snapshot.step
    const inBreak = snapshot.phase === 'break'
    if (inBreak && step?.lactateSample && lastPrompted.current !== snapshot.stepIndex) {
      lastPrompted.current = snapshot.stepIndex
      setLactate({ stepIndex: snapshot.stepIndex, auto: true })
      return
    }
    setLactate((current) =>
      current?.auto && !(inBreak && current.stepIndex === snapshot.stepIndex) ? null : current,
    )
  }, [snapshot.phase, snapshot.stepIndex, snapshot.step])

  const samples = runner.recordedSamples
  const laps = useMemo(
    () => lapsFromSamples(samples, protocol, athlete, runner.lactateEntries),
    [samples.length, protocol, athlete, runner, runner.lactateEntries.length],
  )

  const curves = useMemo<CurveSeries[]>(() => {
    const live = mmpCurve(samples.map((s) => s.power ?? 0))
    const plan = mmpCurve(planPowerSeries(protocol, athlete.ftpWatts))
    const series: CurveSeries[] = [
      { label: 'Plan', color: COLORS.planLine, dashed: true, points: plan },
      { label: 'Live', color: COLORS.power, points: live },
    ]
    if (bestCurve?.length) {
      series.unshift({ label: 'Best', color: COLORS.muted, points: bestCurve })
    }
    return series
  }, [samples.length, protocol, athlete.ftpWatts, bestCurve])

  // Fitted from what the athlete has done before. Without a usable fit the
  // W′ tile hides itself rather than showing a confident meaningless number.
  const cp = useMemo(() => (bestCurve?.length ? criticalPower(bestCurve) : null), [bestCurve])

  // The last two minutes of beat intervals, for the HRV tile.
  const rr = useMemo(() => manager.recentRr(120), [samples.length, manager])

  const tileContext: TileContext = {
    metrics,
    snapshot,
    athlete,
    protocol,
    samples,
    cp,
    rr,
  }

  /**
   * The front face shows what the operator chose; the back shows everything the
   * app can currently compute. A tile with nothing to say is dropped rather
   * than rendered as a dash, because a grid of dashes trains people to stop
   * reading the grid.
   */
  const visibleTiles = useMemo(() => {
    const available = tilesForSport(protocol.sport)
    const keys =
      face === 'front'
        ? frontTiles.length
          ? frontTiles
          : defaultFrontFor(protocol.sport)
        : available.map((t) => t.key)

    return keys
      .map((key) => tileByKey(key))
      .filter((tile): tile is NonNullable<typeof tile> => !!tile)
      .filter((tile) => !tile.sport || tile.sport === protocol.sport)
      .map((tile) => ({ tile, value: tile.compute(tileContext) }))
      .filter((entry): entry is { tile: typeof entry.tile; value: NonNullable<typeof entry.value> } =>
        entry.value !== null,
      )
    // Recomputed on every metric tick and every recorded sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face, frontTiles, protocol.sport, metrics, snapshot, samples.length, cp, rr, athlete])

  const running = snapshot.state === 'running'

  return (
    <div className="dashboard">
      <header className="dash-head">
        <div className="brand">testday</div>
        <div className="who">
          <strong>{athlete.name}</strong>
          <span>{athlete.massKg} kg</span>
          <span>{athlete.ftpWatts} W FTP</span>
          <span>{new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
        </div>
      </header>

      {snapshot.controlError && (
        <div className="banner error">
          Machine control: {snapshot.controlError}
          <button onClick={onOpenSensors}>Sensors</button>
        </div>
      )}

      <section className="tile-face">
        <div className="face-head">
          <span className="muted small">
            {face === 'front' ? 'Dashboard' : 'Everything the app knows'}
          </span>
          <span className="spacer" />
          {face === 'front' && (
            <button className="ghost small" onClick={onEditTiles} title="Choose which tiles appear here">
              Edit
            </button>
          )}
          <button
            className="ghost small"
            onClick={() => setFace(face === 'front' ? 'back' : 'front')}
            title="Flip the tile grid (F)"
          >
            {face === 'front' ? 'Flip ⤺' : '⤻ Back'}
          </button>
        </div>
        <div className={`tiles ${face === 'back' ? 'dense' : ''}`}>
          {visibleTiles.map(({ tile, value }) => (
            <Tile
              key={tile.key}
              label={tile.label}
              value={value.value}
              unit={value.unit}
              note={value.note}
              tone={tile.tone}
              wide={face === 'front' && tile.wide}
              suspect={value.suspect}
            />
          ))}
          {visibleTiles.length === 0 && (
            <div className="empty small">
              Nothing to show yet. Connect a sensor or start the test.
            </div>
          )}
        </div>
      </section>

      <section className="panel graph-panel">
        <div className="panel-head">
          <span className={`pill ${running ? 'live' : ''}`}>
            {snapshot.state === 'finished' ? 'DONE' : running ? 'ACTIVE' : snapshot.state.toUpperCase()}
          </span>
          <strong>{snapshot.step?.name ?? 'Step'}</strong>
          <span className="muted">
            {snapshot.step ? stepLabel(snapshot.step, athlete.ftpWatts, athlete.economyPct ?? 100) : ''} ·{' '}
            {formatCountdown(snapshot.phaseRemainingS)} left · {Math.round(snapshot.stepProgress * 100)}%
          </span>
          <span className="spacer" />
          <span className="muted">Workout graph</span>
        </div>
        <ErrorBoundary label="Workout graph">
          <WorkoutGraph protocol={protocol} athlete={athlete} samples={samples} elapsedS={snapshot.elapsedS} />
        </ErrorBoundary>
      </section>

      <section className="panel mmp-panel">
        <div className="panel-head">
          <span className="muted">Live MMP curve (watt)</span>
        </div>
        <ErrorBoundary label="MMP curve">
          <MmpCurve series={curves} />
        </ErrorBoundary>
      </section>

      <section className="panel laps-panel">
        <div className="panel-head">
          <span className="muted">Laps</span>
          <span className="spacer" />
          <button className="ghost" onClick={() => openLactate(snapshot.stepIndex)}>
            + Lactate
          </button>
        </div>
        <ErrorBoundary label="Lap table">
          <LapTable
            laps={laps}
            protocol={protocol}
            athlete={athlete}
            activeIndex={snapshot.stepIndex}
            state={snapshot.state}
            phaseRemainingS={snapshot.phaseRemainingS}
            onJump={(index) => runner.jumpTo(index)}
            onLactate={openLactate}
          />
        </ErrorBoundary>
      </section>

      <footer className="controls">
        <div className="group">
          <span className="group-label">Intensity</span>
          <button onClick={() => runner.adjustIntensity(-1)}>−1%</button>
          <span className="readout">{snapshot.intensityPct}%</span>
          <button onClick={() => runner.adjustIntensity(1)}>+1%</button>
        </div>

        <div className="group">
          <span className="group-label">Workout</span>
          <button onClick={() => runner.prevStep()}>⏮ Prev step</button>
          <button onClick={() => runner.nextStep()}>Next step ⏭</button>
          {snapshot.step?.recoveryS ? <button onClick={() => runner.skipToBreak()}>To break</button> : null}
          <button className="primary" onClick={() => runner.toggle()}>
            {running ? '⏸ Pause' : '▶ Start'}
          </button>
        </div>

        <span className="spacer" />

        <div className="group">
          <RecordingPill status={status} durability={durability} />
          <button onClick={onOpenSensors}>
            Sensors <span className="count">{manager.devices.length}</span>
          </button>
          <button onClick={onFinish}>Finish &amp; save</button>
        </div>
      </footer>

      {lactate !== null && (
        <LactateDialog
          stepIndex={lactate.stepIndex}
          stepName={protocol.steps[lactate.stepIndex]?.name ?? `Step ${lactate.stepIndex + 1}`}
          existing={runner.lactateEntries.find((l) => l.stepIndex === lactate.stepIndex)}
          suggestedHr={metrics.heartRate}
          onSave={(entry) => {
            runner.recordLactate(entry)
            setLactate(null)
          }}
          onClose={() => setLactate(null)}
        />
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  unit,
  tone,
  wide,
  note,
  suspect,
}: {
  label: string
  value: string
  unit?: string
  tone?: TileTone
  wide?: boolean
  /** Marks a number the app does not fully stand behind, e.g. an extrapolation. */
  suspect?: boolean
  /** Secondary line, e.g. the quality the sensor put on its own reading. */
  note?: string
}) {
  return (
    <div className={`tile ${tone ?? ''} ${wide ? 'wide' : ''} ${suspect ? 'suspect' : ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value}
        {unit && <em>{unit}</em>}
      </span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  )
}

/**
 * Recording state, in view for the whole test. A failed write has to be seen at
 * once: an operator who keeps testing into a dead journal loses the session,
 * which is a worse outcome than the app simply crashing.
 */
function RecordingPill({ status, durability }: { status: RecorderStatus; durability: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (status.error) {
    return (
      <span className="rec bad" title={status.error}>
        ● Not saving — {status.error}
      </span>
    )
  }

  if (!status.recording) {
    return (
      <span className="rec idle" title={durability}>
        ○ Not recording
      </span>
    )
  }

  const ago =
    status.lastDurableAt === null ? null : Math.max(0, Math.round((now - status.lastDurableAt) / 1000))
  // Samples land every second, so nothing for several seconds means the writes
  // have stopped even though no error was raised.
  const stale = ago !== null && ago > 4

  return (
    <span className={stale ? 'rec warn' : 'rec good'} title={durability}>
      ● {formatClock(status.sampleCount)} on disk
      {ago === null ? '' : `, ${ago} s ago`}
    </span>
  )
}

function LactateDialog({
  stepIndex,
  stepName,
  existing,
  suggestedHr,
  onSave,
  onClose,
}: {
  stepIndex: number
  stepName: string
  existing?: { mmol: number; rpe?: number; heartRate?: number; note?: string }
  suggestedHr?: number
  onSave: (entry: { stepIndex: number; mmol: number; rpe?: number; heartRate?: number; note?: string }) => void
  onClose: () => void
}) {
  const [mmol, setMmol] = useState(existing ? String(existing.mmol) : '')
  const [rpe, setRpe] = useState(existing?.rpe ? String(existing.rpe) : '')
  const [note, setNote] = useState(existing?.note ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const value = Number(mmol.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) return
    onSave({
      stepIndex,
      mmol: value,
      rpe: rpe ? Number(rpe) : undefined,
      heartRate: existing?.heartRate ?? suggestedHr,
      note: note || undefined,
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal narrow" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Lactate — {stepName}</h2>
        <label>
          Blood lactate (mmol/L)
          <input
            ref={inputRef}
            inputMode="decimal"
            value={mmol}
            onChange={(e) => setMmol(e.target.value)}
            placeholder="2.4"
          />
        </label>
        <label>
          RPE (Borg 6–20, optional)
          <input inputMode="numeric" value={rpe} onChange={(e) => setRpe(e.target.value)} placeholder="14" />
        </label>
        <label>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Fingertip, 30 s post" />
        </label>
        <p className="muted small">
          Heart rate {suggestedHr ? `${suggestedHr} bpm` : 'unavailable'} is stored with the sample.
        </p>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}

