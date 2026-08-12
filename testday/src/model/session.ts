import {
  isControlled,
  stepLabel,
  stepTotalS,
  targetKphAt,
  targetWattsAt,
  type Athlete,
  type Protocol,
  type Step,
} from './protocol'
import { max, mean } from './metrics'
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
  targetPower?: number
  targetKph?: number
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
}

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

  private listeners = new Set<() => void>()

  constructor(options: RunnerOptions) {
    this.protocol = options.protocol
    this.athlete = options.athlete
    this.readMetrics = options.readMetrics
    this.machine = options.machine ?? (() => null)
    this.now = options.now ?? (() => Date.now())
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
    if (this.state === 'idle') {
      this.startedAt = Date.now()
      void this.machine()?.start().catch(() => undefined)
    }
    this.state = 'running'
    this.lastTickAt = this.now()
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
    this.emit()
  }

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.emit()
  }

  toggle(): void {
    if (this.state === 'running') this.pause()
    else if (this.state !== 'finished') this.start()
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.state = 'finished'
    void this.machine()?.stop().catch(() => undefined)
    this.emit()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
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
    this.intensity = Math.min(1.5, Math.max(0.5, pct / 100))
    this.lastSentWatts = null
    this.lastSentKph = null
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
    this.emit()
  }

  removeLactate(stepIndex: number): void {
    this.lactate = this.lactate.filter((l) => l.stepIndex !== stepIndex)
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
    this.samples.push({
      t: Math.round(t),
      stepIndex: this.stepIndex,
      phase: this.phase,
      power: metrics.power,
      heartRate: metrics.heartRate,
      cadence: metrics.cadence,
      speedMs: metrics.speedMs,
      targetPower: step ? this.targetPower ?? undefined : undefined,
      targetKph: step ? this.targetKph ?? undefined : undefined,
    })
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
          const incline = step?.target.mode === 'speed' ? step.target.inclinePct : undefined
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
   * pricked without fighting the trainer.
   */
  get targetPower(): number | null {
    const step = this.currentStep
    if (!step) return null
    if (this.phase === 'break') {
      return isControlled(step) ? Math.round(this.athlete.ftpWatts * 0.3) : null
    }
    const base = targetWattsAt(step, this.stepElapsedS, this.athlete.ftpWatts)
    return base === null ? null : Math.round(base * this.intensity)
  }

  get targetKph(): number | null {
    const step = this.currentStep
    if (!step || step.target.mode !== 'speed') return null
    if (this.phase === 'break') return 0
    const base = targetKphAt(step, this.stepElapsedS)
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
      target: stepLabel(step, athlete.ftpWatts),
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
