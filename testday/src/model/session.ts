import {
  isControlled,
  recoveryWatts,
  stepInclinePct,
  stepLabel,
  stepTotalS,
  targetKphAt,
  targetWattsAt,
  type Athlete,
  type Protocol,
  type Step,
} from './protocol'
import { max, mean } from './metrics'
import { estimateVo2, type Vo2Method } from './vo2'
import type { MachineControl, MetricUpdate } from '../ble/types'

export type RunnerState = 'idle' | 'running' | 'paused' | 'finished'

/** Steps are split into a work phase and an optional sampling break. */
export type Phase = 'work' | 'break'

export interface Sample {
  /** Seconds since the test started, at 1 Hz. */
  t: number
  stepIndex: number
  phase: Phase
  power?: number
  heartRate?: number
  cadence?: number
  speedMs?: number
  /**
   * Treadmill gradient in percent. The machine's own reading when it sends one;
   * otherwise the value the runner commanded, flagged below. Kept because it is
   * the second argument to every running metabolic equation, so a session
   * recorded without it cannot have its oxygen cost reconstructed afterwards.
   */
  inclinePct?: number
  /** Set only when `inclinePct` is the commanded value, not a measured one. */
  inclineFromTarget?: true
  /** Distance in metres, preferring the machine's own odometer. */
  distanceM?: number
  /** Set only when `distanceM` was integrated from speed rather than reported. */
  distanceIntegrated?: true
  /** Trainer resistance level, which is what the athlete works against off ERG. */
  resistance?: number
  targetPower?: number
  targetKph?: number
  targetInclinePct?: number
  /**
   * Estimated oxygen cost, mL/kg/min, with the equation that produced it. An
   * estimate exported without its method is indistinguishable from a
   * measurement, so the two are always written together or not at all.
   */
  vo2Est?: number
  vo2Method?: Vo2Method
  /** CORE sensor, when one is connected. Recorded with its own quality flag. */
  coreTempC?: number
  skinTempC?: number
  heatStrainIndex?: number
  /** 0 invalid, 1 poor, 2 fair, 3 good, 4 excellent. */
  coreQuality?: number
  /** 0 HRM unsupported, 1 supported but not receiving, 2 receiving. */
  coreHrmState?: number
}

export interface LactateEntry {
  stepIndex: number
  /** Blood lactate in mmol/L. */
  mmol: number
  /** Borg RPE, 6–20. */
  rpe?: number
  heartRate?: number
  note?: string
  at: number
  /**
   * A value the operator cleared. Recorded rather than deleted, because the
   * journal is append-only: the withdrawal is itself part of what happened.
   */
  removed?: boolean
}

/** Beat-to-beat intervals as they were reported, timestamped on the session clock. */
export interface RrEntry {
  t: number
  ms: number[]
}

export interface SessionRecord {
  id: string
  protocolId: string
  protocolName: string
  sport: Protocol['sport']
  athlete: Athlete
  startedAt: number
  endedAt?: number
  samples: Sample[]
  lactate: LactateEntry[]
  /** Present when a strap reported them. Not resampled onto the 1 Hz clock. */
  rr?: RrEntry[]
  notes?: string
}

export interface Lap {
  stepIndex: number
  name: string
  target: string
  targetWatts: number | null
  durationS: number
  avgPower: number | null
  maxPower: number | null
  avgHeartRate: number | null
  maxHeartRate: number | null
  avgCadence: number | null
  avgSpeedMs: number | null
  lactate?: number
}

export interface RunnerSnapshot {
  state: RunnerState
  elapsedS: number
  stepIndex: number
  phase: Phase
  /** Seconds left in the current work phase or break. */
  phaseRemainingS: number
  stepProgress: number
  intensityPct: number
  targetPower: number | null
  targetKph: number | null
  step: Step | null
  totalS: number
  controlError: string | null
}

export interface RunnerOptions {
  protocol: Protocol
  athlete: Athlete
  /** Live metric source, polled once per recorded sample. */
  readMetrics: () => MetricUpdate
  machine?: () => MachineControl | null
  now?: () => number
  /** Fired when the test first starts, before any sample exists. */
  onStart?: (startedAt: number) => void
  /**
   * Fired for every recorded sample, so the recorder can put it on disk
   * immediately. Never fired for samples restored by `resumeFrom`, which are
   * already there.
   */
  onSample?: (sample: Sample) => void
  onLactate?: (entry: LactateEntry) => void
  /**
   * Fired for every operator action that changes how the protocol is being
   * executed. Recorded because the protocol as written and the protocol as run
   * diverge the moment anyone trims intensity or skips a stage, and afterwards
   * only the journal can say which happened.
   */
  onEvent?: (kind: RunnerEventKind, data?: Record<string, number | string | boolean>) => void
}

/** Operator actions worth putting in the journal. */
export type RunnerEventKind = 'start' | 'pause' | 'resume' | 'jump' | 'intensity'

const TICK_MS = 200
const SAMPLE_INTERVAL_S = 1
/** Below this the machine is not worth re-commanding. */
const POWER_EPSILON_W = 1
const SPEED_EPSILON_KPH = 0.05

/**
 * Drives a protocol in real time: advances steps, computes the current target,
 * pushes it to the machine, and records a 1 Hz sample stream.
 *
 * Elapsed time is accumulated from wall-clock deltas rather than counting
 * ticks, so a throttled background tab does not silently slow the test down.
 */
export class TestRunner {
  private readonly protocol: Protocol
  private readonly athlete: Athlete
  private readonly readMetrics: () => MetricUpdate
  private readonly machine: () => MachineControl | null
  private readonly now: () => number
  private readonly onStart?: (startedAt: number) => void
  private readonly onSample?: (sample: Sample) => void
  private readonly onLactate?: (entry: LactateEntry) => void
  private readonly onEvent?: RunnerOptions['onEvent']

  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt = 0
  private nextSampleAt = 0

  private state: RunnerState = 'idle'
  private elapsedS = 0
  private stepIndex = 0
  private stepElapsedS = 0
  private intensity = 1
  private controlError: string | null = null

  private lastSentWatts: number | null = null
  private lastSentKph: number | null = null
  private controlInFlight = false

  private samples: Sample[] = []
  private lactate: LactateEntry[] = []
  private startedAt = 0
  /** Fallback odometer, used only when the machine reports no distance. */
  private integratedDistanceM = 0

  private listeners = new Set<() => void>()

  constructor(options: RunnerOptions) {
    this.protocol = options.protocol
    this.athlete = options.athlete
    this.readMetrics = options.readMetrics
    this.machine = options.machine ?? (() => null)
    this.now = options.now ?? (() => Date.now())
    this.onStart = options.onStart
    this.onSample = options.onSample
    this.onLactate = options.onLactate
    this.onEvent = options.onEvent
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.cachedSnapshot = null
    for (const fn of this.listeners) fn()
  }

  // --- lifecycle ----------------------------------------------------------

  start(): void {
    if (this.state === 'running') return
    const first = this.state === 'idle'
    if (first) {
      this.startedAt = Date.now()
      // Announced before the first sample can be taken, so the recorder has a
      // journal open by the time one arrives.
      this.onStart?.(this.startedAt)
      void this.machine()?.start().catch(() => undefined)
    }
    this.onEvent?.(first ? 'start' : 'resume', { stepIndex: this.stepIndex })
    this.state = 'running'
    this.lastTickAt = this.now()
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
    this.emit()
  }

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.onEvent?.('pause', { stepIndex: this.stepIndex, elapsedS: Math.round(this.elapsedS) })
    this.emit()
  }

  toggle(): void {
    if (this.state === 'running') this.pause()
    else if (this.state !== 'finished') this.start()
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.state === 'running') {
      this.onEvent?.('pause', { stepIndex: this.stepIndex, elapsedS: Math.round(this.elapsedS) })
    }
    this.state = 'finished'
    void this.machine()?.stop().catch(() => undefined)
    this.emit()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  /**
   * Restores a session recovered from disk: its samples, its lactate values,
   * and the clock position those imply. Comes back paused, so the operator
   * decides when the athlete is ready rather than the app deciding for them.
   *
   * Restored samples are deliberately not pushed back through `onSample`: they
   * are already in the journal, and re-emitting them would duplicate every one.
   */
  resumeFrom(session: SessionRecord): void {
    this.samples = [...session.samples]
    this.lactate = [...session.lactate]
    this.startedAt = session.startedAt

    const last = this.samples[this.samples.length - 1]
    if (!last) {
      this.state = 'paused'
      this.emit()
      return
    }

    this.elapsedS = last.t
    this.nextSampleAt = last.t + SAMPLE_INTERVAL_S
    // Pick the odometer up where it stopped, so a resumed session does not
    // restart its distance at zero halfway through.
    this.integratedDistanceM = last.distanceM ?? 0

    // Walk the protocol to find which step that elapsed time lands in.
    let remaining = this.elapsedS
    let index = 0
    while (index < this.protocol.steps.length) {
      const total = stepTotalS(this.protocol.steps[index])
      if (remaining < total) break
      remaining -= total
      index += 1
    }

    if (index >= this.protocol.steps.length) {
      // The protocol already ran to the end. Come back paused at the last step
      // rather than finished: `toggle()` refuses to start a finished runner, so
      // a finished state here would make the session impossible to reopen from
      // the dashboard. Pressing start now completes it again immediately, which
      // is honest; to record more, jump to a step first.
      this.stepIndex = this.protocol.steps.length - 1
      this.stepElapsedS = stepTotalS(this.protocol.steps[this.stepIndex])
    } else {
      this.stepIndex = index
      this.stepElapsedS = remaining
    }
    this.state = 'paused'
    this.emit()
  }

  // --- navigation ---------------------------------------------------------

  nextStep(): void {
    this.jumpTo(this.stepIndex + 1)
  }

  prevStep(): void {
    // Restart the current step first, the way a lap button behaves, and only
    // step back when the operator hits it again near the start.
    if (this.stepElapsedS > 3) this.jumpTo(this.stepIndex)
    else this.jumpTo(this.stepIndex - 1)
  }

  jumpTo(index: number): void {
    if (index >= this.protocol.steps.length) {
      this.finish()
      return
    }
    this.stepIndex = Math.max(0, index)
    this.stepElapsedS = 0
    this.lastSentWatts = null
    this.lastSentKph = null
    this.onEvent?.('jump', { stepIndex: this.stepIndex, elapsedS: Math.round(this.elapsedS) })
    this.emit()
  }

  /** Ends the current work phase early and drops straight into its break. */
  skipToBreak(): void {
    const step = this.currentStep
    if (!step || !step.recoveryS) {
      this.nextStep()
      return
    }
    this.stepElapsedS = Math.max(this.stepElapsedS, step.durationS)
    this.emit()
  }

  setIntensity(pct: number): void {
    const next = Math.min(1.5, Math.max(0.5, pct / 100))
    if (next === this.intensity) return
    this.intensity = next
    this.lastSentWatts = null
    this.lastSentKph = null
    this.onEvent?.('intensity', {
      pct: Math.round(this.intensity * 100),
      stepIndex: this.stepIndex,
    })
    this.emit()
  }

  adjustIntensity(deltaPct: number): void {
    this.setIntensity(Math.round(this.intensity * 100) + deltaPct)
  }

  // --- lactate ------------------------------------------------------------

  recordLactate(entry: Omit<LactateEntry, 'at'> & { at?: number }): void {
    const existing = this.lactate.findIndex((l) => l.stepIndex === entry.stepIndex)
    const record: LactateEntry = { ...entry, at: entry.at ?? Date.now() }
    if (existing >= 0) this.lactate[existing] = record
    else this.lactate.push(record)
    this.onLactate?.(record)
    this.emit()
  }

  removeLactate(stepIndex: number): void {
    this.lactate = this.lactate.filter((l) => l.stepIndex !== stepIndex)
    this.onLactate?.({ stepIndex, mmol: 0, at: Date.now(), removed: true })
    this.emit()
  }

  // --- the loop -----------------------------------------------------------

  private tick(): void {
    const now = this.now()
    const dt = (now - this.lastTickAt) / 1000
    this.lastTickAt = now
    if (this.state !== 'running' || dt <= 0) return

    this.elapsedS += dt
    this.stepElapsedS += dt

    // A long stall (sleeping tab, blocked main thread) can span whole steps.
    let guard = 0
    while (this.state === 'running' && guard++ < 1000) {
      const step = this.currentStep
      if (!step) {
        this.finish()
        return
      }
      const total = stepTotalS(step)
      if (this.stepElapsedS < total) break
      this.stepElapsedS -= total
      this.stepIndex += 1
      this.lastSentWatts = null
      this.lastSentKph = null
      if (this.stepIndex >= this.protocol.steps.length) {
        this.finish()
        return
      }
    }

    this.applyTarget()

    while (this.elapsedS >= this.nextSampleAt) {
      this.record(this.nextSampleAt)
      this.nextSampleAt += SAMPLE_INTERVAL_S
    }

    this.emit()
  }

  private record(t: number): void {
    const metrics = this.readMetrics()
    const step = this.currentStep

    // Distance comes from the machine's own odometer when it has one, because
    // that is the number on the display in front of the athlete. Integrating
    // speed is the fallback, and it is flagged, because the two drift apart
    // over a long test and afterwards nobody can tell which they are reading.
    this.integratedDistanceM += (metrics.speedMs ?? 0) * SAMPLE_INTERVAL_S
    const machineDistance = metrics.distanceM
    const integrated = machineDistance == null

    // A treadmill that reports its gradient is believed. One that does not is
    // assumed to be at the gradient it was commanded to, which is true whenever
    // the command succeeded, and flagged so a later reader can see the
    // difference between a measurement and an assumption.
    const commandedIncline = step ? stepInclinePct(step) : null
    const measuredIncline = metrics.inclinePct
    const inclinePct = measuredIncline ?? commandedIncline ?? undefined

    const speedKph = metrics.speedMs == null ? undefined : metrics.speedMs * 3.6
    const estimate = estimateVo2(
      this.protocol.sport,
      { speedKph, inclinePct, watts: metrics.power },
      this.athlete,
    )

    const sample: Sample = {
      t: Math.round(t),
      stepIndex: this.stepIndex,
      phase: this.phase,
      power: metrics.power,
      heartRate: metrics.heartRate,
      cadence: metrics.cadence,
      speedMs: metrics.speedMs,
      inclinePct,
      inclineFromTarget: inclinePct != null && measuredIncline == null ? true : undefined,
      distanceM: machineDistance ?? Number(this.integratedDistanceM.toFixed(1)),
      distanceIntegrated: integrated ? true : undefined,
      resistance: metrics.resistance,
      targetPower: step ? this.targetPower ?? undefined : undefined,
      targetKph: step ? this.targetKph ?? undefined : undefined,
      targetInclinePct: commandedIncline ?? undefined,
      vo2Est: estimate ? Number(estimate.vo2.toFixed(2)) : undefined,
      vo2Method: estimate?.method,
      // Recorded exactly as reported, quality included. Judging a reading is
      // something to do afterwards with the quality flag in hand, not
      // something to do by silently dropping it now.
      coreTempC: metrics.coreTempC,
      skinTempC: metrics.skinTempC,
      heatStrainIndex: metrics.heatStrainIndex,
      coreQuality: metrics.coreQuality,
      coreHrmState: metrics.coreHrmState,
    }
    this.samples.push(sample)
    this.onSample?.(sample)
  }

  /** Sends the current target to the machine, skipping redundant writes. */
  private applyTarget(): void {
    const control = this.machine()
    if (!control || this.controlInFlight) return

    const watts = this.targetPower
    const kph = this.targetKph

    const send = async (fn: () => Promise<void>) => {
      this.controlInFlight = true
      try {
        await fn()
        if (this.controlError) {
          this.controlError = null
          this.emit()
        }
      } catch (error) {
        this.controlError = error instanceof Error ? error.message : String(error)
        this.lastSentWatts = null
        this.lastSentKph = null
        this.emit()
      } finally {
        this.controlInFlight = false
      }
    }

    if (watts != null && control.canSetPower) {
      const rounded = Math.round(watts)
      if (this.lastSentWatts === null || Math.abs(rounded - this.lastSentWatts) >= POWER_EPSILON_W) {
        this.lastSentWatts = rounded
        void send(() => control.setTargetPower(rounded))
      }
      return
    }

    if (kph != null && control.canSetSpeed) {
      if (this.lastSentKph === null || Math.abs(kph - this.lastSentKph) >= SPEED_EPSILON_KPH) {
        this.lastSentKph = kph
        void send(async () => {
          await control.setTargetSpeedKph(kph)
          const step = this.currentStep
          const incline = step ? stepInclinePct(step) : null
          if (incline != null && control.canSetIncline) await control.setTargetInclinePct(incline)
        })
      }
    }
  }

  // --- derived state ------------------------------------------------------

  get currentStep(): Step | null {
    return this.protocol.steps[this.stepIndex] ?? null
  }

  get phase(): Phase {
    const step = this.currentStep
    if (!step) return 'work'
    return this.stepElapsedS >= step.durationS ? 'break' : 'work'
  }

  /**
   * Target during a sampling break drops to an easy spin so the athlete can be
   * pricked without fighting the trainer. How easy is the protocol's business,
   * not the runner's.
   */
  get targetPower(): number | null {
    const step = this.currentStep
    if (!step) return null
    if (this.phase === 'break') {
      return isControlled(step) ? recoveryWatts(step, this.protocol, this.athlete.ftpWatts) : null
    }
    const base = targetWattsAt(step, this.stepElapsedS, this.athlete.ftpWatts)
    return base === null ? null : Math.round(base * this.intensity)
  }

  get targetKph(): number | null {
    const step = this.currentStep
    if (!step) return null
    if (this.phase === 'break') return 0
    // Covers both a speed target and a VO₂ target solved to a speed.
    const base = targetKphAt(step, this.stepElapsedS, this.athlete.economyPct ?? 100)
    return base === null ? null : Number((base * this.intensity).toFixed(2))
  }

  private cachedSnapshot: RunnerSnapshot | null = null

  /** Stable object identity between emits, for `useSyncExternalStore`. */
  snapshot(): RunnerSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot
    const step = this.currentStep
    const phase = this.phase
    const phaseRemainingS = step
      ? phase === 'work'
        ? step.durationS - this.stepElapsedS
        : stepTotalS(step) - this.stepElapsedS
      : 0

    this.cachedSnapshot = {
      state: this.state,
      elapsedS: this.elapsedS,
      stepIndex: this.stepIndex,
      phase,
      phaseRemainingS: Math.max(0, phaseRemainingS),
      stepProgress: step ? Math.min(1, this.stepElapsedS / stepTotalS(step)) : 0,
      intensityPct: Math.round(this.intensity * 100),
      targetPower: this.targetPower,
      targetKph: this.targetKph,
      step,
      totalS: this.protocol.steps.reduce((sum, s) => sum + stepTotalS(s), 0),
      controlError: this.controlError,
    }
    return this.cachedSnapshot
  }

  /**
   * Seconds on the session clock right now.
   *
   * The native-rate stream timestamps itself against this rather than against
   * the wall clock, so a notification that arrives while the test is paused is
   * filed at the second the test was paused at, and the two streams stay
   * alignable. Wall-clock time travels separately on each record.
   */
  get elapsed(): number {
    return this.elapsedS
  }

  get recordedSamples(): readonly Sample[] {
    return this.samples
  }

  get lactateEntries(): readonly LactateEntry[] {
    return this.lactate
  }

  toRecord(id: string): SessionRecord {
    return {
      id,
      protocolId: this.protocol.id,
      protocolName: this.protocol.name,
      sport: this.protocol.sport,
      athlete: this.athlete,
      startedAt: this.startedAt || Date.now(),
      endedAt: this.state === 'finished' ? Date.now() : undefined,
      samples: this.samples,
      lactate: this.lactate,
    }
  }
}

/**
 * Per-step summary. Only work-phase samples count, so a lap's averages are not
 * dragged down by the easy spin during a blood draw.
 */
export function lapsFromSamples(
  samples: readonly Sample[],
  protocol: Protocol,
  athlete: Athlete,
  lactate: readonly LactateEntry[] = [],
): Lap[] {
  const byStep = new Map<number, Sample[]>()
  for (const sample of samples) {
    if (sample.phase !== 'work') continue
    const list = byStep.get(sample.stepIndex)
    if (list) list.push(sample)
    else byStep.set(sample.stepIndex, [sample])
  }

  return protocol.steps.map((step, index) => {
    const stepSamples = byStep.get(index) ?? []
    const power = pluck(stepSamples, 'power')
    const hr = pluck(stepSamples, 'heartRate')
    const cadence = pluck(stepSamples, 'cadence')
    const speed = pluck(stepSamples, 'speedMs')
    const targetWatts = targetWattsAt(step, step.durationS / 2, athlete.ftpWatts)

    return {
      stepIndex: index,
      name: step.name ?? `Step ${index + 1}`,
      target: stepLabel(step, athlete.ftpWatts, athlete.economyPct ?? 100),
      targetWatts: targetWatts === null ? null : Math.round(targetWatts),
      durationS: step.durationS,
      avgPower: power.length ? Math.round(mean(power)) : null,
      maxPower: power.length ? Math.round(max(power)) : null,
      avgHeartRate: hr.length ? Math.round(mean(hr)) : null,
      maxHeartRate: hr.length ? Math.round(max(hr)) : null,
      avgCadence: cadence.length ? Math.round(mean(cadence)) : null,
      avgSpeedMs: speed.length ? Number(mean(speed).toFixed(2)) : null,
      lactate: lactate.find((l) => l.stepIndex === index)?.mmol,
    }
  })
}

function pluck(samples: readonly Sample[], key: keyof Sample): number[] {
  const out: number[] = []
  for (const sample of samples) {
    const value = sample[key]
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  }
  return out
}
