/**
 * Making the watts the protocol asks for the watts the athlete actually
 * produces.
 *
 * A trainer in ERG mode holds *its own* measurement at the commanded target.
 * That is not the same quantity as the power the rider is putting through the
 * pedals, and the gap between them is neither small nor stable. In a
 * fifty-minute session recorded on 14 August 2026 at a commanded 200 W, the
 * reference meter read +4.9% at the start and -0.7% at the end: the load fell
 * by about 12 W while every label in the file said 200 W. A drivetrain loss of
 * one and a half to three percent is real physics and stays put; the rest of
 * that was the trainer's own estimate rising as it warmed, which it corrected
 * for by quietly making the athlete work less.
 *
 * A step test's whole premise is a known work rate, so this is a measurement
 * failure rather than a display problem, and the fix is to close the loop on
 * the meter that is worth trusting instead of on the one doing the controlling.
 *
 * Two instruments, because one of them cannot do the job alone:
 *
 *   - **Feed-forward.** One multiplier, measured against the reference meter
 *     during the warm-up (see `ble/probe.ts`), applied to every commanded
 *     target from its first second. It cannot oscillate and it does not care
 *     how long a step is, so a sixty-second ramp step is corrected properly.
 *   - **A slow trim.** A rolling comparison inside steps long enough to
 *     tolerate it, which is what catches the drift above. Rate-limited,
 *     dead-banded and hard-clamped, because the trainer is already running a
 *     control loop of its own and two loops that fight each other replace a
 *     steady offset with a hunting one, which is worse.
 *
 * The loop faithfully imposes the reference meter's own error on the athlete:
 * it cannot tell a drifting trainer from a drifting meter. That is why the
 * reference has to be a meter worth believing, why its identity is recorded,
 * and why `ReferenceWatch` below says so out loud when it cannot tell.
 *
 * Everything this module decides is recorded. The commanded value, the factor
 * in force, every trim and every hold go into the journal, because a closed
 * loop whose behaviour cannot be reconstructed afterwards has no place in a
 * test.
 */

export interface PowerMatchConfig {
  /** Seconds between trim adjustments. Slow on purpose. */
  trimIntervalS: number
  /** Length of the rolling mean a trim is computed from. */
  trimWindowS: number
  /** Steps shorter than this are never trimmed, only fed forward. */
  minStepForTrimS: number
  /** Seconds after a target change before the trim looks again. */
  settleS: number
  /** Relative error below which nothing is adjusted. */
  deadbandPct: number
  /** Largest single trim adjustment. */
  maxTrimStepPct: number
  /** Hard clamp on the total correction, feed-forward and trim together. */
  maxCorrectionPct: number
  /** Reference power older than this counts as missing. */
  referenceStaleS: number
}

/**
 * Deliberately unadventurous.
 *
 * The trim interval is long because the trainer's own loop settles in about a
 * second and anything close to that timescale is a fight. The clamp is 15%,
 * which is well outside any drivetrain loss and any calibration offset worth
 * correcting: a correction that wants more than that is not a correction, it is
 * two devices disagreeing about what a watt is, and that needs an operator
 * rather than a control loop.
 */
export const POWER_MATCH_DEFAULTS: PowerMatchConfig = {
  trimIntervalS: 30,
  trimWindowS: 30,
  minStepForTrimS: 120,
  settleS: 20,
  deadbandPct: 1,
  maxTrimStepPct: 2,
  maxCorrectionPct: 15,
  referenceStaleS: 5,
}

export type PowerMatchState =
  /** No multiplier measured yet: commanding the raw target. */
  | 'uncalibrated'
  /** Feed-forward only, either by configuration or because the step is short. */
  | 'feedforward'
  /** Feed-forward plus the slow trim, inside a step long enough for it. */
  | 'trimming'
  /** Reference meter missing: last known factor held, and said so. */
  | 'holding'

export interface PowerMatchEvent {
  kind: 'calibrated' | 'trim' | 'clamped' | 'hold' | 'resume'
  /** Session clock, seconds. */
  t: number
  /** The factor in force after this event. */
  factor: number
  data?: Record<string, number | string | boolean>
}

export interface PowerMatchObservation {
  /** Session clock, seconds. */
  t: number
  /** What the protocol is asking for at the pedals. Null off a power target. */
  targetW: number | null
  /** Reference meter reading, undefined when it is not arriving. */
  referenceW?: number
  stepIndex: number
  /** Full length of the current step, for deciding whether a trim is allowed. */
  stepDurationS: number
  /** True during a sampling break, when nothing is steady enough to trim on. */
  onBreak: boolean
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/**
 * The correction, and the record of how it got there.
 *
 * Holds no timers of its own: it is driven by the runner's sample clock, which
 * makes it testable at any speed and keeps the session clock the only clock.
 */
export class PowerMatch {
  private readonly config: PowerMatchConfig
  /** Measured in the warm-up. 1 until it is. */
  private feedForward = 1
  private calibrated = false
  /** The running correction on top of the feed-forward multiplier. */
  private trim = 1
  private state: PowerMatchState = 'uncalibrated'

  /** Readings inside the current stable window: [t, referenceW]. */
  private window: { t: number; w: number }[] = []
  private lastTargetW: number | null = null
  private lastStepIndex = -1
  /** Session time at which the current target became stable. */
  private stableSince: number | null = null
  private lastTrimAt: number | null = null
  private lastReferenceAt: number | null = null

  private pending: PowerMatchEvent[] = []

  constructor(config: Partial<PowerMatchConfig> = {}) {
    this.config = { ...POWER_MATCH_DEFAULTS, ...config }
  }

  /**
   * Accepts the multiplier measured by the warm-up probe.
   *
   * Clamped on the way in: a probe that comes back asking for a 40% correction
   * has measured something other than a drivetrain, and applying it would be
   * the loop's first and worst mistake.
   */
  calibrate(multiplier: number, at: number, source = 'probe'): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) return
    const limit = this.config.maxCorrectionPct / 100
    const clamped = clamp(multiplier, 1 - limit, 1 + limit)
    this.feedForward = clamped
    this.trim = 1
    this.calibrated = true
    this.state = 'feedforward'
    this.pending.push({
      kind: 'calibrated',
      t: at,
      factor: this.factor,
      data: {
        multiplier: Number(multiplier.toFixed(4)),
        applied: Number(clamped.toFixed(4)),
        clamped: clamped !== multiplier,
        source,
      },
    })
  }

  /** Commanded value for a protocol target. Rounding is the caller's business. */
  command(targetW: number): number {
    return targetW * this.factor
  }

  /** Feed-forward and trim together, which is what multiplies the target. */
  get factor(): number {
    const limit = this.config.maxCorrectionPct / 100
    return clamp(this.feedForward * this.trim, 1 - limit, 1 + limit)
  }

  get currentState(): PowerMatchState {
    return this.state
  }

  get isCalibrated(): boolean {
    return this.calibrated
  }

  /** True while the reference meter is missing and the factor is being held. */
  get isHolding(): boolean {
    return this.state === 'holding'
  }

  /** Events since the last call, for the journal. */
  drain(): PowerMatchEvent[] {
    const out = this.pending
    this.pending = []
    return out
  }

  /**
   * One sample's worth of evidence.
   *
   * Called at the recording rate. Everything about when a trim is allowed lives
   * here rather than in the runner, so the rules are in one readable place and
   * can be tested without a trainer.
   */
  observe(obs: PowerMatchObservation): void {
    const { config } = this

    // Reference presence first: a hold is worth recording even when nothing
    // else about the step would have permitted a trim.
    if (obs.referenceW != null && Number.isFinite(obs.referenceW)) {
      this.lastReferenceAt = obs.t
      if (this.state === 'holding') {
        this.state = this.calibrated ? 'feedforward' : 'uncalibrated'
        this.pending.push({ kind: 'resume', t: obs.t, factor: this.factor })
      }
    } else if (
      this.lastReferenceAt != null &&
      obs.t - this.lastReferenceAt > config.referenceStaleS &&
      this.state !== 'holding'
    ) {
      // Hold what was last known rather than reverting to a raw target: the
      // revert would put a step change in the athlete's actual load at the
      // exact moment the record stops being able to explain it.
      this.state = 'holding'
      this.pending.push({
        kind: 'hold',
        t: obs.t,
        factor: this.factor,
        data: { sinceS: Number((obs.t - this.lastReferenceAt).toFixed(1)) },
      })
    }

    // A changed target, a changed step or a break resets the window. The
    // trainer needs time to arrive and the athlete needs time to settle, and
    // averaging across the transient is how a trim gets computed from a number
    // that was never true.
    const targetChanged =
      obs.targetW !== this.lastTargetW || obs.stepIndex !== this.lastStepIndex
    if (targetChanged) {
      this.lastTargetW = obs.targetW
      this.lastStepIndex = obs.stepIndex
      this.window = []
      this.stableSince = obs.t
    }

    if (this.state === 'holding') return
    if (obs.targetW == null || obs.targetW <= 0 || obs.onBreak) {
      this.state = this.calibrated ? 'feedforward' : 'uncalibrated'
      return
    }
    if (obs.stepDurationS < config.minStepForTrimS) {
      // Correct it, but do not chase it. Nothing here can settle in time.
      this.state = this.calibrated ? 'feedforward' : 'uncalibrated'
      return
    }

    this.state = 'trimming'

    if (obs.referenceW == null || !Number.isFinite(obs.referenceW)) return
    this.window.push({ t: obs.t, w: obs.referenceW })
    const cutoff = obs.t - config.trimWindowS
    while (this.window.length && this.window[0].t < cutoff) this.window.shift()

    const settledFor = this.stableSince == null ? 0 : obs.t - this.stableSince
    if (settledFor < config.settleS) return
    if (this.window.length < Math.max(5, config.trimWindowS / 2)) return
    if (this.lastTrimAt != null && obs.t - this.lastTrimAt < config.trimIntervalS) return

    const mean = this.window.reduce((sum, s) => sum + s.w, 0) / this.window.length
    if (mean <= 0) return

    const errorPct = (mean / obs.targetW - 1) * 100
    this.lastTrimAt = obs.t
    if (Math.abs(errorPct) < config.deadbandPct) return

    // Reference reading low means the athlete is doing less than the protocol
    // asked for, so the trainer is told to ask for more.
    const wanted = obs.targetW / mean
    const step = config.maxTrimStepPct / 100
    const applied = clamp(wanted, 1 - step, 1 + step)
    const before = this.factor
    this.trim *= applied
    const after = this.factor

    if (after === before) {
      // The clamp swallowed it whole: the correction has run out of room, and
      // that is a fact about the equipment rather than a quiet no-op.
      this.pending.push({
        kind: 'clamped',
        t: obs.t,
        factor: after,
        data: {
          referenceMeanW: Number(mean.toFixed(1)),
          targetW: obs.targetW,
          errorPct: Number(errorPct.toFixed(2)),
          limitPct: config.maxCorrectionPct,
        },
      })
      return
    }

    this.pending.push({
      kind: 'trim',
      t: obs.t,
      factor: Number(after.toFixed(4)),
      data: {
        referenceMeanW: Number(mean.toFixed(1)),
        targetW: obs.targetW,
        errorPct: Number(errorPct.toFixed(2)),
        appliedPct: Number(((applied - 1) * 100).toFixed(2)),
        windowN: this.window.length,
      },
    })
  }
}

// --- agreement between two power sources -------------------------------------

export interface PowerAgreement {
  /** Seconds of overlap the figures rest on. */
  n: number
  meanReferenceW: number
  meanMachineW: number
  /** Reference minus machine. Positive is the normal direction for a drivetrain. */
  biasW: number
  biasPct: number
  /**
   * Change in bias across the session, percentage points per hour, by least
   * squares on per-minute means. Null until there are two minutes to compare.
   *
   * This is the number that catches a warming trainer. A stable bias is a
   * drivetrain and is uninteresting; a bias that moves is the load changing
   * underneath a constant label.
   */
  driftPctPerHour: number | null
}

/**
 * Live comparison of the reference meter against the machine's own reading.
 *
 * Item 4 of the borrowed-improvements document, and the reason any of the rest
 * of this file can be believed: a single power trace cannot show its own error.
 * Kept as per-minute bins so a session of any length costs nothing and the
 * drift term has something honest to fit.
 */
export class PowerAgreementTracker {
  private bins = new Map<number, { ref: number; mach: number; n: number }>()
  private total = { ref: 0, mach: 0, n: 0 }

  add(t: number, referenceW?: number, machineW?: number): void {
    if (referenceW == null || machineW == null) return
    if (!Number.isFinite(referenceW) || !Number.isFinite(machineW)) return
    // Coasting tells you nothing about agreement and drags every mean toward
    // zero, where two devices always agree.
    if (referenceW < 20 || machineW < 20) return

    const minute = Math.floor(t / 60)
    const bin = this.bins.get(minute) ?? { ref: 0, mach: 0, n: 0 }
    bin.ref += referenceW
    bin.mach += machineW
    bin.n += 1
    this.bins.set(minute, bin)

    this.total.ref += referenceW
    this.total.mach += machineW
    this.total.n += 1
  }

  read(): PowerAgreement | null {
    if (this.total.n === 0) return null
    const meanRef = this.total.ref / this.total.n
    const meanMach = this.total.mach / this.total.n
    return {
      n: this.total.n,
      meanReferenceW: Number(meanRef.toFixed(1)),
      meanMachineW: Number(meanMach.toFixed(1)),
      biasW: Number((meanRef - meanMach).toFixed(1)),
      biasPct: Number(((meanRef / meanMach - 1) * 100).toFixed(2)),
      driftPctPerHour: this.drift(),
    }
  }

  /** Least-squares slope of per-minute bias against time, in %/hour. */
  private drift(): number | null {
    const points: { x: number; y: number }[] = []
    for (const [minute, bin] of [...this.bins].sort((a, b) => a[0] - b[0])) {
      // A minute with only a few seconds in it is noise, not a point.
      if (bin.n < 20 || bin.mach <= 0) continue
      points.push({ x: minute, y: (bin.ref / bin.mach - 1) * 100 })
    }
    if (points.length < 2) return null

    const n = points.length
    const meanX = points.reduce((s, p) => s + p.x, 0) / n
    const meanY = points.reduce((s, p) => s + p.y, 0) / n
    let num = 0
    let den = 0
    for (const p of points) {
      num += (p.x - meanX) * (p.y - meanY)
      den += (p.x - meanX) ** 2
    }
    if (den === 0) return null
    // Slope is percentage points per minute; an hour is the readable unit.
    return Number(((num / den) * 60).toFixed(2))
  }
}

/**
 * Agreement read back off a recorded session.
 *
 * Derived rather than held in memory, so it survives a crash-resume and says
 * the same thing about a session reopened next week as it did on the day.
 */
export function agreementFromSamples(
  samples: readonly { power?: number; powerSecondaryW?: number; t: number }[],
): PowerAgreement | null {
  const tracker = new PowerAgreementTracker()
  for (const sample of samples) tracker.add(sample.t, sample.power, sample.powerSecondaryW)
  return tracker.read()
}

// --- is the reference worth closing a loop on? -------------------------------

export type Sidedness = 'unknown' | 'single' | 'dual'

export interface ReferenceVerdict {
  sidedness: Sidedness
  /** Warnings to record on the session and print on the report. */
  warnings: string[]
}

/**
 * Whether the reference meter can be believed enough to drive an athlete with.
 *
 * The gate decision for item 76 is to warn rather than block, which puts a real
 * obligation here: since nothing stops a single-sided meter from becoming the
 * reference, and the loop would then drive the athlete to a doubled left leg,
 * the warning has to survive into the session record and onto the report. A
 * warning that exists only on screen at Start is the same as no warning at all.
 *
 * Bluetooth will not simply say how many sides a meter measures. What it will
 * do is report pedal power balance, and a single-sided meter that reports it at
 * all reports exactly 50.0% forever, because it is halving one leg and
 * doubling it again. Constant 50.0 is therefore evidence, not proof, and a
 * meter that never reports balance leaves the question open, which is said
 * rather than guessed at.
 */
export class ReferenceWatch {
  private samples = 0
  private nonFifty = 0

  observe(balancePct?: number): void {
    if (balancePct == null || !Number.isFinite(balancePct)) return
    this.samples += 1
    if (Math.abs(balancePct - 50) > 0.4) this.nonFifty += 1
  }

  get sidedness(): Sidedness {
    if (this.samples < 30) return 'unknown'
    return this.nonFifty > 0 ? 'dual' : 'single'
  }

  verdict(options: { hasSeparateReference: boolean; hasZeroOffset: boolean }): ReferenceVerdict {
    const warnings: string[] = []
    if (!options.hasSeparateReference) {
      warnings.push(
        'No second power source: the trainer is being compared with itself, so its power cannot be checked and no correction can be measured.',
      )
    }
    if (!options.hasZeroOffset) {
      warnings.push(
        'No zero offset recorded for the reference meter this session. The correction imposes whatever offset the meter has.',
      )
    }
    const sidedness = this.sidedness
    if (sidedness === 'single') {
      warnings.push(
        'Reference meter reports a constant 50/50 balance, which is what a single-sided meter does. It is doubling one leg, and the correction will drive the athlete to that doubled figure.',
      )
    } else if (sidedness === 'unknown' && options.hasSeparateReference) {
      warnings.push(
        'Reference meter does not report pedal balance, so whether it measures both legs is unknown. Confirm it is dual-sided or crank-based.',
      )
    }
    return { sidedness, warnings }
  }
}
