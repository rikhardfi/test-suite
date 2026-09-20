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
import { max, mean, normalizedPower } from './metrics'
import type { PowerMatch, PowerMatchState } from './powermatch'
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
   * The controllable machine's own power, when a separate meter supplied
   * `power`. Never blended into it: the difference between the two is the
   * measurement, not noise to be averaged away.
   */
  powerSecondaryW?: number
  /**
   * What was actually commanded to the machine, when that differs from
   * `targetPower`.
   *
   * `targetPower` stays the protocol's number, which is what the athlete is
   * meant to be producing. This is what the trainer was told to do in order to
   * make that true at the pedals, and keeping the two apart is the whole reason
   * a corrected session can still be read afterwards.
   */
  commandedPower?: number
  /** Correction in force: commanded = targetPower x this. */
  powerMatchFactor?: number
  /** Set when the reference meter was missing and the last factor was held. */
  powerMatchHeld?: true
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
  /**
   * TSI flow meter, summarised onto this second at export time from
   * `flow.ndjson` (see `withExhaled`); never recorded here. Means over the
   * second of protocol time ending at `t`. Humidity is absent for a second
   * containing a saturated reading, and coverage is the share of the second
   * the meter actually sent.
   */
  exhaledFlowLMin?: number
  exhaledGasTempC?: number
  exhaledRhPct?: number
  exhaledCoverage?: number
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

/**
 * Conditions the test was run in.
 *
 * Unrecorded conditions make an airway result uninterpretable afterwards, and
 * afterwards is when it gets interpreted. Cold, dry or CO₂-loaded indoor air is
 * a conditioning load on the airway, so it is part of the measurement rather
 * than context for it. Entered by hand when no monitor is connected, which will
 * be most sessions.
 */
export interface Environment {
  tempC?: number
  humidityPct?: number
  co2Ppm?: number
  pressureHpa?: number
  altitudeM?: number
  setting?: 'indoor' | 'outdoor'
  note?: string
  /**
   * Whether these came from a sensor, from the operator, or from a monitor's
   * own log brought in afterwards.
   */
  source: 'sensor' | 'manual' | 'mixed' | 'import'
  at: number
}

/** One thing the operator or a sensor did, kept in the order it happened. */
export interface SessionEvent {
  kind: string
  at: number
  data?: Record<string, number | string | boolean>
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
  /**
   * Operator actions in order: starts, pauses, jumps, intensity trims, sensor
   * handovers. This is the protocol as executed, which diverges from the
   * protocol as written the moment anybody touches anything.
   */
  events?: SessionEvent[]
  /** Conditions, from the environment monitor and from the operator's form. */
  environment?: Environment[]
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
  /** Metres covered during the step, from whichever odometer was in use. */
  distanceM: number | null
  /** Fourth-power weighted average, null for a step too short to have one. */
  normalizedPower: number | null
  /** Mechanical work, kJ. */
  workKj: number | null
  /** Energy cost, kcal, from the oxygen estimate where there is one. */
  kcal: number | null
  avgVo2: number | null
  avgInclinePct: number | null
  lactate?: number
  rpe?: number
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
  /** The watts the rider has chosen, when free ride has set the protocol aside. */
  freeRideWatts: number | null
  targetPower: number | null
  targetKph: number | null
  /** What the machine was last told, when a correction is changing it. */
  commandedPower: number | null
  powerMatchFactor: number | null
  powerMatchState: PowerMatchState | null
  step: Step | null
  totalS: number
  controlError: string | null
  /** The last target the machine confirmed, and when. */
  controlAck: ControlAck | null
  /**
   * Seconds the machine has gone without confirming the target in force, zero
   * when it has. The target on the screen is what was asked for; this is the
   * only figure that says whether the machine agreed.
   */
  controlBehindS: number
}

export interface ControlAck {
  value: number
  unit: 'W' | 'km/h'
  at: number
}

export interface RunnerOptions {
  protocol: Protocol
  athlete: Athlete
  /** Live metric source, polled once per recorded sample. */
  readMetrics: () => MetricUpdate
  machine?: () => MachineControl | null
  /**
   * The power correction, when one is running. Absent means the raw protocol
   * target is commanded, which is what every session before this did.
   */
  powerMatch?: PowerMatch
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
export type RunnerEventKind =
  | 'start'
  | 'pause'
  | 'resume'
  | 'jump'
  | 'intensity'
  /**
   * Free ride switched on or off, or its watts changed. While it is on the
   * load is the rider's and not the protocol's, and a record that did not say
   * so would show a step ridden at the wrong power with no explanation.
   */
  | 'freeRide'
  /**
   * The power correction, in full. A closed loop that cannot be reconstructed
   * afterwards has no business driving an athlete, so every calibration, every
   * trim, every time the clamp bit and every stretch spent holding a factor
   * without a reference meter goes into the journal as it happens.
   */
  | 'powerMatchCalibrated'
  | 'powerMatchTrim'
  | 'powerMatchClamped'
  | 'powerMatchHold'
  | 'powerMatchResume'
  /**
   * The machine stopped confirming targets, and later started again. Between
   * the two, the recorded target is what was asked for and not what was set.
   */
  | 'controlBehind'
  | 'controlRecovered'

/** Journal kinds for what the correction reports about itself. */
const POWER_MATCH_EVENTS = {
  calibrated: 'powerMatchCalibrated',
  trim: 'powerMatchTrim',
  clamped: 'powerMatchClamped',
  hold: 'powerMatchHold',
  resume: 'powerMatchResume',
} as const satisfies Record<string, RunnerEventKind>

const TICK_MS = 200
const SAMPLE_INTERVAL_S = 1
/** Below this the machine is not worth re-commanding. */
const POWER_EPSILON_W = 1
const SPEED_EPSILON_KPH = 0.05
/**
 * How long a target may go unconfirmed before it is said out loud. A healthy
 * command is confirmed in a fraction of a second and a failed one times out at
 * four, so this is past anything that resolves on its own.
 */
const CONTROL_BEHIND_S = 5
/** Where free ride starts when there is neither a target nor a power reading. */
const FREE_RIDE_START_W = 100

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
  private readonly powerMatch?: PowerMatch
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
  private freeWatts: number | null = null
  private controlError: string | null = null

  private lastSentWatts: number | null = null
  private lastSentKph: number | null = null
  private controlInFlight = false
  private controlAck: ControlAck | null = null
  private behindSince: number | null = null
  private behindReported = false

  private samples: Sample[] = []
  private lactate: LactateEntry[] = []
  private startedAt = 0
  /** Fallback odometer, used only when the machine reports no distance. */
  private integratedDistanceM = 0
  /**
   * What the machine's own odometer read when this session's distance was zero.
   *
   * A treadmill is usually already rolling when a test starts — the athlete
   * steps on to a moving belt — so its odometer arrives with a warm-up already
   * on it. Subtracting where it started is what makes the session's distance
   * the distance of the session. Null until the machine has reported once.
   */
  private machineOriginM: number | null = null
  /** The last distance reported from the machine, after the origin is removed. */
  private machineDistanceM = 0

  private listeners = new Set<() => void>()

  constructor(options: RunnerOptions) {
    this.protocol = options.protocol
    this.athlete = options.athlete
    this.readMetrics = options.readMetrics
    this.machine = options.machine ?? (() => null)
    this.powerMatch = options.powerMatch
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
    this.behindSince = null
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
    // restart its distance at zero halfway through. The machine's origin is
    // left unset: the next reading re-anchors against this figure, which is
    // what makes a resume survive the machine having been stopped, zeroed or
    // swapped in between.
    this.integratedDistanceM = last.distanceM ?? 0
    this.machineDistanceM = last.distanceM ?? 0
    this.machineOriginM = null

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

  /**
   * Free ride: the trainer stays in ERG, holding the watts the rider asks for
   * instead of the protocol's. The clock, the steps and the recording carry on
   * untouched, so switching it off drops back into the step that is due.
   */
  setFreeRide(watts: number | null): void {
    if (this.protocol.sport !== 'bike') return
    const range = this.machine()?.powerRange
    const next =
      watts === null ? null : Math.round(Math.min(range?.max ?? 2000, Math.max(range?.min ?? 0, watts)))
    if (next === this.freeWatts) return
    this.freeWatts = next
    this.lastSentWatts = null
    this.onEvent?.('freeRide', {
      on: next !== null,
      watts: next ?? '',
      stepIndex: this.stepIndex,
      elapsedS: Math.round(this.elapsedS),
    })
    this.emit()
  }

  /** Starts from the load already on the pedals, so switching on changes nothing. */
  toggleFreeRide(): void {
    if (this.freeWatts !== null) return this.setFreeRide(null)
    const riding = this.readMetrics().power
    this.setFreeRide(this.targetPower ?? (riding != null ? Math.round(riding / 5) * 5 : FREE_RIDE_START_W))
  }

  adjustFreeRide(deltaW: number): void {
    if (this.freeWatts !== null) this.setFreeRide(this.freeWatts + deltaW)
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
    //
    // The odometer is read as a difference from where it stood at the start,
    // never as an absolute. Anchoring on the first reading covers the warm-up
    // already on the belt; re-anchoring when it goes backwards covers the
    // machine being zeroed mid-test, and keeps the session's distance running
    // on from where it was rather than dropping back to nothing.
    this.integratedDistanceM += (metrics.speedMs ?? 0) * SAMPLE_INTERVAL_S
    const reported = metrics.distanceM
    const integrated = reported == null
    if (reported != null) {
      if (this.machineOriginM == null || reported < this.machineOriginM) {
        this.machineOriginM = reported - this.machineDistanceM
      }
      this.machineDistanceM = Number((reported - this.machineOriginM).toFixed(1))
    }

    // A treadmill that reports its gradient is believed. One that does not is
    // assumed to be at the gradient it was commanded to, which is true whenever
    // the command succeeded, and flagged so a later reader can see the
    // difference between a measurement and an assumption.
    const commandedIncline = step ? stepInclinePct(step) : null
    const measuredIncline = metrics.inclinePct
    const inclinePct = measuredIncline ?? commandedIncline ?? undefined

    // The correction sees the reference meter and the protocol's target, and
    // decides on its own clock whether anything is steady enough to act on.
    // Called before the sample is built so the sample carries the state that
    // was in force for it rather than the state a second later.
    const targetPower = step ? this.targetPower : null
    if (this.powerMatch) {
      this.powerMatch.observe({
        t,
        targetW: targetPower,
        referenceW: metrics.power,
        stepIndex: this.stepIndex,
        stepDurationS: step?.durationS ?? 0,
        onBreak: this.phase === 'break',
      })
      for (const event of this.powerMatch.drain()) {
        this.onEvent?.(POWER_MATCH_EVENTS[event.kind], {
          ...event.data,
          t: Number(event.t.toFixed(1)),
          factor: Number(event.factor.toFixed(4)),
        })
      }
    }

    const factor = this.powerMatch?.factor ?? 1
    const commanded =
      targetPower != null && factor !== 1 ? Math.round(targetPower * factor) : null

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
      distanceM: integrated ? Number(this.integratedDistanceM.toFixed(1)) : this.machineDistanceM,
      distanceIntegrated: integrated ? true : undefined,
      resistance: metrics.resistance,
      targetPower: targetPower ?? undefined,
      targetKph: step ? this.targetKph ?? undefined : undefined,
      targetInclinePct: commandedIncline ?? undefined,
      // Both traces, and the arithmetic between them, so that a reader a year
      // from now can see what the athlete produced, what the machine thought,
      // what it was told, and why those three differ.
      powerSecondaryW: metrics.powerSecondaryW,
      commandedPower: commanded ?? undefined,
      powerMatchFactor: factor === 1 ? undefined : Number(factor.toFixed(4)),
      powerMatchHeld: this.powerMatch?.isHolding ? true : undefined,
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
    if (!control) return

    const watts = this.targetPower
    const kph = this.targetKph

    // Checked on every tick, in flight or not: a command that never comes back
    // is exactly the case this exists for.
    if (watts != null && control.canSetPower) {
      const wanted = Math.round(this.powerMatch ? this.powerMatch.command(watts) : watts)
      this.trackBehind(wanted, 'W', POWER_EPSILON_W)
    } else if (kph != null && control.canSetSpeed) {
      this.trackBehind(kph, 'km/h', SPEED_EPSILON_KPH)
    }
    if (this.controlInFlight) return

    const send = async (ack: Omit<ControlAck, 'at'>, fn: () => Promise<void>) => {
      this.controlInFlight = true
      try {
        await fn()
        this.controlAck = { ...ack, at: Date.now() }
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
      // The machine is commanded the corrected figure; the protocol's own
      // number is what gets recorded and reported. Correcting the record
      // instead of the command would make the file agree with itself and
      // disagree with the athlete.
      const rounded = Math.round(this.powerMatch ? this.powerMatch.command(watts) : watts)
      if (this.lastSentWatts === null || Math.abs(rounded - this.lastSentWatts) >= POWER_EPSILON_W) {
        this.lastSentWatts = rounded
        void send({ value: rounded, unit: 'W' }, () => control.setTargetPower(rounded))
      }
      return
    }

    if (kph != null && control.canSetSpeed) {
      if (this.lastSentKph === null || Math.abs(kph - this.lastSentKph) >= SPEED_EPSILON_KPH) {
        this.lastSentKph = kph
        void send({ value: kph, unit: 'km/h' }, async () => {
          await control.setTargetSpeedKph(kph)
          const step = this.currentStep
          const incline = step ? stepInclinePct(step) : null
          if (incline != null && control.canSetIncline) await control.setTargetInclinePct(incline)
        })
      }
    }
  }

  /**
   * Notes when the machine has not confirmed the target in force, and says so
   * in the journal once it has gone on too long. The session of 18 September
   * 2026 ran 32 minutes at a load 4% under its label with nothing on the screen
   * or in the record to show it; this is the line that would have.
   */
  private trackBehind(wanted: number, unit: ControlAck['unit'], epsilon: number): void {
    const ack = this.controlAck
    const confirmed = ack != null && ack.unit === unit && Math.abs(ack.value - wanted) < epsilon
    if (confirmed) {
      if (this.behindReported) {
        this.onEvent?.('controlRecovered', { wanted, unit, stepIndex: this.stepIndex })
      }
      this.behindSince = null
      this.behindReported = false
      return
    }
    this.behindSince ??= this.now()
    if (!this.behindReported && this.now() - this.behindSince >= CONTROL_BEHIND_S * 1000) {
      this.behindReported = true
      this.onEvent?.('controlBehind', {
        wanted,
        unit,
        acknowledged: ack?.unit === unit ? ack.value : '',
        stepIndex: this.stepIndex,
      })
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
    if (this.freeWatts !== null) return this.freeWatts
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
      freeRideWatts: this.freeWatts,
      targetPower: this.targetPower,
      targetKph: this.targetKph,
      commandedPower: this.lastSentWatts,
      powerMatchFactor: this.powerMatch ? this.powerMatch.factor : null,
      powerMatchState: this.powerMatch?.currentState ?? null,
      step,
      totalS: this.protocol.steps.reduce((sum, s) => sum + stepTotalS(s), 0),
      controlError: this.controlError,
      controlAck: this.controlAck,
      controlBehindS:
        this.state === 'running' && this.behindSince != null
          ? Math.max(0, (this.now() - this.behindSince) / 1000)
          : 0,
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
    const distances = pluck(stepSamples, 'distanceM')
    const vo2 = pluck(stepSamples, 'vo2Est')
    const incline = pluck(stepSamples, 'inclinePct')
    const entry = lactate.find((l) => l.stepIndex === index)

    // Work is the integral of power over the step, which at 1 Hz is the sum in
    // joules. Energy cost prefers the recorded oxygen estimate, so the number
    // here and the number the dashboard showed are the same number.
    const workJ = power.reduce((sum, watts) => sum + watts, 0)
    const kcal = vo2.length
      ? vo2.reduce((sum, value) => sum + (value * athlete.massKg) / 1000 / 60 * 5, 0)
      : power.length
        ? workJ / 1000 / 4.184 / 0.22
        : 0

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
      distanceM: distances.length ? Number((distances[distances.length - 1] - distances[0]).toFixed(1)) : null,
      normalizedPower: normalizedPower(power),
      workKj: power.length ? Number((workJ / 1000).toFixed(1)) : null,
      kcal: kcal > 0 ? Math.round(kcal) : null,
      avgVo2: vo2.length ? Number(mean(vo2).toFixed(1)) : null,
      avgInclinePct: incline.length ? Number(mean(incline).toFixed(1)) : null,
      lactate: entry?.mmol,
      rpe: entry?.rpe,
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
