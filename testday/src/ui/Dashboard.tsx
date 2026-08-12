import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkoutGraph } from './WorkoutGraph'
import { MmpCurve, type CurveSeries } from './MmpCurve'
import { LapTable } from './LapTable'
import { COLORS } from './theme'
import { useHotkeys, useLiveMetrics, useRunnerSnapshot } from './hooks'
import { formatClock, formatCountdown, mmpCurve } from '../model/metrics'
import { planPowerSeries, stepLabel, type Athlete, type Protocol } from '../model/protocol'
import { lapsFromSamples, type TestRunner } from '../model/session'
import type { SensorManager } from '../ble/manager'

interface Props {
  runner: TestRunner
  protocol: Protocol
  athlete: Athlete
  manager: SensorManager
  bestCurve?: { durationS: number; watts: number }[]
  onOpenSensors: () => void
  onFinish: () => void
}

export function Dashboard({
  runner,
  protocol,
  athlete,
  manager,
  bestCurve,
  onOpenSensors,
  onFinish,
}: Props) {
  const snapshot = useRunnerSnapshot(runner)
  const metrics = useLiveMetrics(manager)
  const [lactate, setLactate] = useState<{ stepIndex: number; auto: boolean } | null>(null)
  const isRun = protocol.sport === 'run'
  const openLactate = (stepIndex: number) => setLactate({ stepIndex, auto: false })

  useHotkeys({
    ' ': () => runner.toggle(),
    ArrowRight: () => runner.nextStep(),
    ArrowLeft: () => runner.prevStep(),
    ArrowUp: () => runner.adjustIntensity(1),
    ArrowDown: () => runner.adjustIntensity(-1),
    l: () => openLactate(snapshot.stepIndex),
  })

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

  const running = snapshot.state === 'running'
  const targetLabel = isRun
    ? snapshot.targetKph != null
      ? `${snapshot.targetKph.toFixed(1)}`
      : '—'
    : snapshot.targetPower != null
      ? String(snapshot.targetPower)
      : '—'

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

      <section className="tiles">
        <Tile label="Timer" value={formatClock(snapshot.elapsedS)} tone="power" wide />
        <Tile
          label={snapshot.phase === 'break' ? 'Sample break' : 'Lap time left'}
          value={formatCountdown(snapshot.phaseRemainingS)}
          tone={snapshot.phase === 'break' ? 'lactate' : 'heart'}
          wide
        />
        <Tile label="Heart rate" value={fmt(metrics.heartRate)} unit="bpm" tone="heart" wide />
        <Tile label="Cadence" value={fmt(metrics.cadence)} unit={isRun ? 'spm' : 'rpm'} />
        <Tile
          label={isRun ? 'Speed' : 'Power'}
          value={isRun ? fmt(metrics.speedMs != null ? metrics.speedMs * 3.6 : undefined, 1) : fmt(metrics.power)}
          unit={isRun ? 'km/h' : 'W'}
          tone="power"
        />
        <Tile
          label={isRun ? 'Target speed' : 'Target power'}
          value={targetLabel}
          unit={isRun ? 'km/h' : 'W'}
          tone="target"
        />
      </section>

      <section className="panel graph-panel">
        <div className="panel-head">
          <span className={`pill ${running ? 'live' : ''}`}>
            {snapshot.state === 'finished' ? 'DONE' : running ? 'ACTIVE' : snapshot.state.toUpperCase()}
          </span>
          <strong>{snapshot.step?.name ?? 'Step'}</strong>
          <span className="muted">
            {snapshot.step ? stepLabel(snapshot.step, athlete.ftpWatts) : ''} ·{' '}
            {formatCountdown(snapshot.phaseRemainingS)} left · {Math.round(snapshot.stepProgress * 100)}%
          </span>
          <span className="spacer" />
          <span className="muted">Workout graph</span>
        </div>
        <WorkoutGraph protocol={protocol} athlete={athlete} samples={samples} elapsedS={snapshot.elapsedS} />
      </section>

      <section className="panel mmp-panel">
        <div className="panel-head">
          <span className="muted">Live MMP curve (watt)</span>
        </div>
        <MmpCurve series={curves} />
      </section>

      <section className="panel laps-panel">
        <div className="panel-head">
          <span className="muted">Laps</span>
          <span className="spacer" />
          <button className="ghost" onClick={() => openLactate(snapshot.stepIndex)}>
            + Lactate
          </button>
        </div>
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
}: {
  label: string
  value: string
  unit?: string
  tone?: 'power' | 'heart' | 'target' | 'lactate'
  wide?: boolean
}) {
  return (
    <div className={`tile ${tone ?? ''} ${wide ? 'wide' : ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value}
        {unit && <em>{unit}</em>}
      </span>
    </div>
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

const fmt = (value: number | undefined, decimals = 0): string =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(decimals)
