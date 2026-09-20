import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { WorkoutGraph } from './WorkoutGraph'
import { DurationCurve, type CurveSeries } from './DurationCurve'
import { Nomogram } from './Nomogram'
import { LapTable } from './LapTable'
import { COLORS } from './theme'
import { useHotkeys, useLiveMetrics, useRunnerSnapshot } from './hooks'
import { defaultFrontFor, tileByKey, tilesForSport, type TileContext, type TileTone } from './tiles'
import { formatClock, formatCountdown, mmpCurve } from '../model/metrics'
import { criticalPower } from '../model/analysis'
import { planPowerSeries, stepLabel, type Athlete, type Protocol } from '../model/protocol'
import { lapsFromSamples, type Environment, type RunnerSnapshot, type TestRunner } from '../model/session'
import { speedCurve } from '../model/running'
import { NO_MOTION, machineIsMoving, watchMotion, type MotionWatch } from '../model/motion'
import { agreementFromSamples, type PowerAgreement } from '../model/powermatch'
import { explainControlError } from '../ble/ftms'
import type { RecorderStatus } from '../model/recorder'
import type { SensorManager } from '../ble/manager'
import { Modal } from './Modal'

/** Where the two dashboard dividers sit, as a percentage of the grid. */
export interface PanelSplit {
  colsPct: number
  rowsPct: number
}

export const DEFAULT_SPLIT: PanelSplit = { colsPct: 74, rowsPct: 40 }

const clampSplit = (split: PanelSplit): PanelSplit => ({
  colsPct: Math.min(88, Math.max(35, split.colsPct)),
  rowsPct: Math.min(75, Math.max(15, split.rowsPct)),
})

interface Props {
  runner: TestRunner
  protocol: Protocol
  athlete: Athlete
  manager: SensorManager
  /** Remembered divider positions for this sport. */
  layout?: PanelSplit
  onLayoutChange: (split: PanelSplit) => void
  bestCurve?: { durationS: number; watts: number }[]
  status: RecorderStatus
  /** How this build stores a recording, said plainly. */
  durability: string
  /** Tile keys on the front face, in order. Empty means the defaults. */
  frontTiles: string[]
  onOpenSensors: () => void
  onEditTiles: () => void
  onEditEnvironment: () => void
  /** What was last entered under Conditions, for the tile that needs it. */
  conditions?: Environment | null
  onFinish: () => void
}

export function Dashboard({
  runner,
  protocol,
  athlete,
  manager,
  layout,
  onLayoutChange,
  bestCurve,
  status,
  durability,
  frontTiles,
  onOpenSensors,
  onEditTiles,
  onEditEnvironment,
  conditions,
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

  /**
   * The machine left running with nothing being recorded. Polled on its own
   * timer rather than off the metric stream, so that a sensor which stops
   * sending — a treadmill whose last message said "3 m/s" and then went quiet —
   * still resolves one way or the other instead of leaving the alarm latched.
   */
  const [motion, setMotion] = useState<MotionWatch>(NO_MOTION)
  const recording = snapshot.state === 'running'
  useEffect(() => {
    const tick = () =>
      setMotion((previous) =>
        watchMotion(previous, {
          moving: machineIsMoving(protocol.sport, manager.read()),
          recording,
          nowMs: Date.now(),
        }),
      )
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [manager, protocol.sport, recording])

  const samples = runner.recordedSamples
  /**
   * How the two power sources are getting on, recomputed as samples arrive.
   *
   * Derived from the record rather than accumulated in state, so it reads the
   * same on a session resumed from disk as it did while it was being run.
   */
  const agreement = useMemo(() => agreementFromSamples(samples), [samples.length])
  const laps = useMemo(
    () => lapsFromSamples(samples, protocol, athlete, runner.lactateEntries),
    [samples.length, protocol, athlete, runner, runner.lactateEntries.length],
  )

  const curves = useMemo<CurveSeries[]>(() => {
    const asValues = (points: { durationS: number; watts: number }[]) =>
      points.map((p) => ({ durationS: p.durationS, value: p.watts }))
    const series: CurveSeries[] = [
      {
        label: 'Plan',
        color: COLORS.planLine,
        dashed: true,
        points: asValues(mmpCurve(planPowerSeries(protocol, athlete.ftpWatts))),
      },
      {
        label: 'Live',
        color: COLORS.power,
        points: asValues(mmpCurve(samples.map((s) => s.power ?? 0))),
      },
    ]
    if (bestCurve?.length) {
      series.unshift({ label: 'Best', color: COLORS.muted, points: asValues(bestCurve) })
    }
    return series
  }, [samples.length, protocol, athlete.ftpWatts, bestCurve])

  /** The running counterpart: best sustained flat-equivalent speed by duration. */
  const runCurves = useMemo<CurveSeries[]>(
    () => [
      {
        label: 'Live',
        color: COLORS.power,
        points: speedCurve(samples, athlete.economyPct ?? 100).map((p) => ({
          durationS: p.durationS,
          value: p.kph,
        })),
      },
    ],
    [samples.length, athlete.economyPct],
  )

  /**
   * Which chart the second panel shows. A mean-maximal *power* curve on a
   * treadmill is a curve of zeroes, so a run gets the two charts that mean
   * something there instead, and the choice is remembered while the app runs.
   */
  const [runView, setRunView] = useState<'nomogram' | 'speed'>('nomogram')

  const dashRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState<PanelSplit>(layout ?? DEFAULT_SPLIT)
  const [dragging, setDragging] = useState<'cols' | 'rows' | null>(null)
  const splitRef = useRef(split)
  splitRef.current = split

  // Adopt a remembered layout when the sport changes under us.
  useEffect(() => {
    setSplit(layout ?? DEFAULT_SPLIT)
  }, [layout])

  /**
   * Dragging works in deltas rather than absolute positions, so the divider
   * stays under the pointer whatever else is above it in the grid.
   */
  const startDrag = (axis: 'cols' | 'rows') => (event: React.PointerEvent) => {
    const box = dashRef.current?.getBoundingClientRect()
    if (!box) return
    event.preventDefault()
    const from = splitRef.current
    const startX = event.clientX
    const startY = event.clientY
    setDragging(axis)

    const move = (e: PointerEvent) => {
      const deltaPct =
        axis === 'cols'
          ? ((e.clientX - startX) / box.width) * 100
          : ((e.clientY - startY) / box.height) * 100
      const next = clampSplit(
        axis === 'cols'
          ? { ...from, colsPct: from.colsPct + deltaPct }
          : { ...from, rowsPct: from.rowsPct + deltaPct },
      )
      setSplit(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(null)
      // Written once, at the end, rather than on every pixel of the drag.
      onLayoutChange(splitRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

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
    conditions,
  }

  /**
   * The front face shows what the operator chose; the back shows every tile the
   * sport has.
   *
   * A tile with nothing to say keeps its place and shows a dash, dimmed. The
   * grid used to drop it, which made the layout rearrange itself as sensors
   * came and went and left nothing on screen at all before anything was
   * connected: the one moment the operator wants to check that the dashboard
   * is set up the way the test needs it.
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
    // Recomputed on every metric tick and every recorded sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face, frontTiles, protocol.sport, metrics, snapshot, samples.length, cp, rr, athlete])

  const running = snapshot.state === 'running'

  return (
    <>
      {motion.alarming && (
        <MotionAlarm
          sport={protocol.sport}
          state={snapshot.state}
          onStop={() => void manager.machine?.control?.stop()}
          canStop={!!manager.machine?.control}
          onStart={() => runner.toggle()}
        />
      )}
      <div
        ref={dashRef}
        className={`dashboard ${dragging ? 'splitting' : ''}`}
        style={
          {
            '--dash-cols': split.colsPct,
            '--dash-rows': split.rowsPct,
          } as React.CSSProperties
        }
      >
      <div
        className={`split split-v ${dragging === 'cols' ? 'dragging' : ''}`}
        onPointerDown={startDrag('cols')}
        onDoubleClick={() => {
          setSplit(DEFAULT_SPLIT)
          onLayoutChange(DEFAULT_SPLIT)
        }}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize. Double-click to reset."
      />
      <div
        className={`split split-h ${dragging === 'rows' ? 'dragging' : ''}`}
        onPointerDown={startDrag('rows')}
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
      />
      <div
        className={`split split-h-right ${dragging === 'rows' ? 'dragging' : ''}`}
        onPointerDown={startDrag('rows')}
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
      />
      <header className="dash-head">
        <div className="brand">testday</div>
        <div className="who">
          <strong>{athlete.name}</strong>
          <span>{athlete.massKg} kg</span>
          <span>{athlete.ftpWatts} W FTP</span>
          <span>{new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
        </div>
        <span className="spacer" />
        <PowerSources snapshot={snapshot} agreement={agreement} manager={manager} />
        {snapshot.controlError && (
          <div className="banner error">
            Machine control: {explainControlError(snapshot.controlError)}
            <button onClick={onOpenSensors}>Sensors</button>
          </div>
        )}
      </header>

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
              value={value ? value.value : '—'}
              unit={value?.unit}
              note={value?.note}
              tone={tile.tone}
              wide={face === 'front' && tile.wide}
              suspect={value?.suspect}
              waiting={value === null}
            />
          ))}
          {visibleTiles.length === 0 && (
            <div className="empty small">
              No tiles are chosen. Use Edit to pick what this face shows.
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
        {protocol.sport === 'bike' ? (
          <>
            <div className="panel-head">
              <span className="muted">Live MMP curve (watt)</span>
            </div>
            <ErrorBoundary label="MMP curve">
              <DurationCurve series={curves} />
            </ErrorBoundary>
          </>
        ) : (
          <>
            <div className="panel-head">
              <span className="muted">
                {runView === 'nomogram' ? 'Pace · gradient · VO₂' : 'Flat-equivalent speed (km/h)'}
              </span>
              <span className="spacer" />
              <div className="segmented small">
                <button
                  className={runView === 'nomogram' ? 'on' : 'ghost'}
                  onClick={() => setRunView('nomogram')}
                >
                  Nomogram
                </button>
                <button
                  className={runView === 'speed' ? 'on' : 'ghost'}
                  onClick={() => setRunView('speed')}
                >
                  Curve
                </button>
              </div>
            </div>
            <ErrorBoundary label={runView === 'nomogram' ? 'Nomogram' : 'Speed curve'}>
              {runView === 'nomogram' ? (
                <Nomogram
                  speedKph={metrics.speedMs == null ? null : metrics.speedMs * 3.6}
                  inclinePct={
                    metrics.inclinePct ?? samples[samples.length - 1]?.inclinePct ?? null
                  }
                  economyPct={athlete.economyPct ?? 100}
                  vo2max={athlete.vo2maxMlKgMin}
                />
              ) : (
                <DurationCurve series={runCurves} decimals={1} minTop={12} />
              )}
            </ErrorBoundary>
          </>
        )}
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
        {snapshot.freeRideWatts === null ? (
          <div className="group">
            <span className="group-label">Intensity</span>
            <button onClick={() => runner.adjustIntensity(-1)}>−1%</button>
            <span className="readout">{snapshot.intensityPct}%</span>
            <button onClick={() => runner.adjustIntensity(1)}>+1%</button>
          </div>
        ) : (
          <div className="group">
            <span className="group-label">Watts</span>
            <button onClick={() => runner.adjustFreeRide(-25)}>−25</button>
            <button onClick={() => runner.adjustFreeRide(-5)}>−5</button>
            <span className="readout">{snapshot.freeRideWatts} W</span>
            <button onClick={() => runner.adjustFreeRide(5)}>+5</button>
            <button onClick={() => runner.adjustFreeRide(25)}>+25</button>
          </div>
        )}
        {protocol.sport === 'bike' && (
          <button
            className={snapshot.freeRideWatts === null ? '' : 'on'}
            aria-pressed={snapshot.freeRideWatts !== null}
            onClick={() => runner.toggleFreeRide()}
            title="Set the protocol's target aside and hold the watts you choose. The clock and the steps keep running."
          >
            Free ride
          </button>
        )}

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
          <button onClick={onEditEnvironment} title="Record the conditions this test was run in">
            Conditions
          </button>
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
    </>
  )
}

/**
 * The machine is live and nothing is being recorded.
 *
 * Deliberately the loudest thing this app draws. Somebody is about to step onto
 * a moving belt, or has walked away from one. It sits above the dashboard
 * rather than inside it, so it cannot be scrolled past or covered by a panel,
 * and it offers the two ways out: stop the machine, or start the test that
 * should have been running.
 */
/** Past this the machine is behind, rather than merely being commanded. */
const CONTROL_BEHIND_WARN_S = 5

/**
 * The two power sources, and what the correction is doing about them.
 *
 * The operator's question during a test is not "what is the power" but "is the
 * power real". One trace cannot answer that. Shown only when there is something
 * to say: two sources reporting, a correction in force, or the machine's own
 * word on the target. One line, in the head, so it costs the dashboard no row.
 *
 * Drift is the number worth watching. A steady bias is a drivetrain and is
 * uninteresting; a bias that moves is the athlete's actual load changing under
 * a label that is not changing, which is the failure this whole feature exists
 * for.
 */
function PowerSources({
  snapshot,
  agreement,
  manager,
}: {
  snapshot: RunnerSnapshot
  agreement: PowerAgreement | null
  manager: SensorManager
}) {
  const pair = manager.powerPair()
  const correcting = snapshot.powerMatchFactor != null && snapshot.powerMatchFactor !== 1
  const ack = snapshot.controlAck
  const behind = snapshot.controlBehindS >= CONTROL_BEHIND_WARN_S
  if (!agreement && !correcting && !ack && !behind) return null

  const drift = agreement?.driftPctPerHour
  // Two percent is the accuracy most trainers claim for themselves, so a bias
  // wider than that is the machine outside its own specification.
  const biasOff = agreement != null && Math.abs(agreement.biasPct) > 2
  const driftOff = drift != null && Math.abs(drift) > 2

  const wanted =
    (snapshot.commandedPower ?? snapshot.targetPower) != null
      ? `${snapshot.commandedPower ?? snapshot.targetPower} W`
      : snapshot.targetKph != null
        ? `${snapshot.targetKph.toFixed(1)} km/h`
        : 'the target'
  const confirmed = ack ? `${ack.unit === 'W' ? ack.value : ack.value.toFixed(1)} ${ack.unit}` : null
  const warn = behind || snapshot.powerMatchState === 'holding'

  return (
    <div className={`power-sources${warn ? ' warn' : ''}`}>
      {pair.reference && (
        <span>
          <strong>{Math.round(pair.reference.watts)} W</strong> {pair.reference.name}
        </span>
      )}
      {pair.machine && (
        <span className="muted">
          {Math.round(pair.machine.watts)} W {pair.machine.name}
        </span>
      )}
      {agreement && (
        <span className={biasOff ? 'flag' : 'muted'}>
          bias {agreement.biasPct > 0 ? '+' : ''}
          {agreement.biasPct.toFixed(1)}%
        </span>
      )}
      {drift != null && (
        <span className={driftOff ? 'flag' : 'muted'} title="Change in bias per hour">
          drift {drift > 0 ? '+' : ''}
          {drift.toFixed(1)}%/h
        </span>
      )}
      {correcting && (
        <span>
          commanding {snapshot.commandedPower ?? '—'} W for {snapshot.targetPower ?? '—'} W
        </span>
      )}
      {snapshot.powerMatchState === 'holding' && (
        <strong className="flag">reference meter missing, correction held</strong>
      )}
      {/*
       * What the machine last confirmed, against what it is being asked for.
       * The target tile shows the request. Nothing else on the screen says
       * whether the machine took it, and a machine that has stopped taking
       * targets looks, from here, exactly like one that is holding them.
       */}
      {behind ? (
        <strong className="flag">
          {wanted} not confirmed for {Math.round(snapshot.controlBehindS)} s
          {confirmed ? `, last confirmed ${confirmed}` : ', nothing confirmed yet'}
        </strong>
      ) : (
        ack && (
          <span className="muted" title={`Machine confirmed ${new Date(ack.at).toLocaleTimeString()}`}>
            ✓ {confirmed}
          </span>
        )
      )}
    </div>
  )
}

function MotionAlarm({
  sport,
  state,
  canStop,
  onStop,
  onStart,
}: {
  sport: 'bike' | 'run'
  state: string
  canStop: boolean
  onStop: () => void
  onStart: () => void
}) {
  const what = sport === 'run' ? 'The treadmill is running' : 'The bike is being driven'
  const why =
    state === 'finished'
      ? 'The test is finished and nothing is being recorded.'
      : state === 'paused'
        ? 'The test is paused and nothing is being recorded.'
        : 'Nothing is being recorded.'

  return (
    <div className="motion-alarm" role="alert">
      <span className="motion-mark" aria-hidden="true">
        ⚠
      </span>
      <div className="motion-text">
        <strong>{what}</strong>
        <span>{why}</span>
      </div>
      <span className="spacer" />
      {canStop && (
        <button className="motion-stop" onClick={onStop}>
          Stop the machine
        </button>
      )}
      <button className="ghost" onClick={onStart}>
        Start recording
      </button>
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
  waiting,
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
  /** Nothing to show yet: the tile holds its place, dimmed, rather than vanishing. */
  waiting?: boolean
}) {
  return (
    <div
      className={`tile ${tone ?? ''} ${wide ? 'wide' : ''} ${suspect ? 'suspect' : ''} ${
        waiting ? 'waiting' : ''
      }`}
    >
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
    <Modal onClose={onClose} className="narrow" as="form" onSubmit={submit}>
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
    </Modal>
  )
}

