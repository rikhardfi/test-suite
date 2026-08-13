import { solveSpeedForVo2 } from './vo2'

export type Sport = 'bike' | 'run'

export type StepTarget =
  /** Absolute watts. */
  | { mode: 'watts'; watts: number; toWatts?: number }
  /** Watts as a percentage of the athlete's threshold power. */
  | { mode: 'ftp'; pctFtp: number; toPctFtp?: number }
  /** Treadmill pace, optionally with a gradient. */
  | { mode: 'speed'; kph: number; toKph?: number; inclinePct?: number }
  /**
   * Treadmill target given as oxygen cost. The speed is solved from the ACSM
   * equation at the step's gradient, using the athlete's economy.
   */
  | { mode: 'vo2'; vo2: number; toVo2?: number; inclinePct?: number }
  /** No machine control: the athlete rides or runs to feel. */
  | { mode: 'free' }

/** What the machine is held at during a sampling break or rest interval. */
export type RecoveryTarget =
  | { mode: 'watts'; watts: number }
  | { mode: 'ftp'; pctFtp: number }

/**
 * The recovery target a protocol falls back to. 30% of threshold reproduces
 * the value that used to be hardcoded in the runner, so protocols written
 * before recovery power was editable behave exactly as they did.
 */
export const DEFAULT_RECOVERY: RecoveryTarget = { mode: 'ftp', pctFtp: 30 }

export interface Step {
  id: string
  name?: string
  durationS: number
  target: StepTarget
  /** Pause the clock at the end of this step for a blood sample. */
  lactateSample?: boolean
  /** Unpaced break appended to the step, e.g. 30 s to draw blood. */
  recoveryS?: number
  /** Overrides the protocol's recovery target for this step's break only. */
  recoveryTarget?: RecoveryTarget
  notes?: string
}

export interface Protocol {
  id: string
  name: string
  description?: string
  sport: Sport
  steps: Step[]
  /** Applies to every break in the protocol unless a step overrides it. */
  recovery?: RecoveryTarget
  createdAt: number
  updatedAt: number
  /** Built-in presets are read-only; editing one clones it. */
  builtIn?: boolean
}

export interface Athlete {
  name: string
  massKg: number
  ftpWatts: number
  maxHr?: number
  restingHr?: number
  birthYear?: number
  /** Running economy as a percentage; 100 is typical, lower is more economical. */
  economyPct?: number
  /** Measured VO₂max, when there is one, for expressing targets as a share of it. */
  vo2maxMlKgMin?: number
}

export const DEFAULT_ATHLETE: Athlete = {
  name: 'Athlete',
  massKg: 75,
  ftpWatts: 300,
  maxHr: 190,
  restingHr: 50,
  economyPct: 100,
}

/**
 * Watts to hold during a step's break: the step's own override, else the
 * protocol's setting, else the default.
 */
export function recoveryWatts(
  step: Step,
  protocol: Pick<Protocol, 'recovery'>,
  ftpWatts: number,
): number {
  const target = step.recoveryTarget ?? protocol.recovery ?? DEFAULT_RECOVERY
  const watts = target.mode === 'watts' ? target.watts : (target.pctFtp / 100) * ftpWatts
  return Math.max(0, Math.round(watts))
}

export const recoveryLabel = (target: RecoveryTarget, ftpWatts: number): string =>
  target.mode === 'watts'
    ? `${target.watts} W`
    : `${Math.round((target.pctFtp / 100) * ftpWatts)} W (${target.pctFtp}%)`

let idCounter = 0
export const newId = (prefix = 'id'): string =>
  `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`

/** Total duration including sampling breaks, in seconds. */
export const protocolDurationS = (protocol: Protocol): number =>
  protocol.steps.reduce((total, step) => total + stepTotalS(step), 0)

export const stepTotalS = (step: Step): number => step.durationS + (step.recoveryS ?? 0)

/**
 * Target at a point inside a step, in watts. Ramping steps interpolate
 * linearly across the *work* portion, ignoring any sampling break.
 */
export function targetWattsAt(step: Step, elapsedInStepS: number, ftpWatts: number): number | null {
  const t = step.durationS > 0 ? clamp01(elapsedInStepS / step.durationS) : 0
  switch (step.target.mode) {
    case 'watts':
      return lerp(step.target.watts, step.target.toWatts ?? step.target.watts, t)
    case 'ftp': {
      const from = (step.target.pctFtp / 100) * ftpWatts
      const to = ((step.target.toPctFtp ?? step.target.pctFtp) / 100) * ftpWatts
      return lerp(from, to, t)
    }
    default:
      return null
  }
}

/** Target oxygen cost at a point inside a VO₂-targeted step, in mL/kg/min. */
export function targetVo2At(step: Step, elapsedInStepS: number): number | null {
  if (step.target.mode !== 'vo2') return null
  const t = step.durationS > 0 ? clamp01(elapsedInStepS / step.durationS) : 0
  return lerp(step.target.vo2, step.target.toVo2 ?? step.target.vo2, t)
}

/** Gradient the treadmill is held at, for either treadmill target mode. */
export function stepInclinePct(step: Step): number | null {
  if (step.target.mode === 'speed' || step.target.mode === 'vo2') {
    return step.target.inclinePct ?? null
  }
  return null
}

/**
 * Target at a point inside a step, in km/h. A VO₂-targeted step is solved
 * through the ACSM equation at the step's gradient, so the treadmill still
 * receives a speed.
 */
export function targetKphAt(step: Step, elapsedInStepS: number, economyPct = 100): number | null {
  const t = step.durationS > 0 ? clamp01(elapsedInStepS / step.durationS) : 0
  if (step.target.mode === 'speed') {
    return lerp(step.target.kph, step.target.toKph ?? step.target.kph, t)
  }
  if (step.target.mode === 'vo2') {
    const vo2 = targetVo2At(step, elapsedInStepS)
    if (vo2 === null) return null
    const kph = solveSpeedForVo2(vo2, step.target.inclinePct ?? 0, economyPct)
    return kph === null ? null : Number(kph.toFixed(2))
  }
  return null
}

/** Nominal intensity of a step, used for labels and the plan trace. */
export function stepLabel(step: Step, ftpWatts: number, economyPct = 100): string {
  switch (step.target.mode) {
    case 'watts':
      return step.target.toWatts && step.target.toWatts !== step.target.watts
        ? `${step.target.watts}→${step.target.toWatts} W`
        : `${step.target.watts} W`
    case 'ftp': {
      const watts = Math.round((step.target.pctFtp / 100) * ftpWatts)
      return `${watts} W (${step.target.pctFtp}%)`
    }
    case 'speed':
      return step.target.toKph && step.target.toKph !== step.target.kph
        ? `${step.target.kph}→${step.target.toKph} km/h`
        : `${step.target.kph} km/h`
    case 'vo2': {
      const kph = targetKphAt(step, 0, economyPct)
      const range =
        step.target.toVo2 && step.target.toVo2 !== step.target.vo2
          ? `${step.target.vo2}→${step.target.toVo2}`
          : `${step.target.vo2}`
      // The solved speed is what the treadmill actually gets, so it is shown
      // next to the prescription rather than left for the operator to infer.
      return kph === null ? `VO₂ ${range}` : `VO₂ ${range} (${kph.toFixed(1)} km/h)`
    }
    default:
      return 'free'
  }
}

export const isControlled = (step: Step): boolean => step.target.mode !== 'free'

// --- builders -------------------------------------------------------------

export interface StepTestOptions {
  startWatts: number
  stepWatts: number
  stepDurationS: number
  stepCount: number
  /** Break after each step for a blood draw. */
  sampleBreakS?: number
  warmupWatts?: number
  warmupDurationS?: number
}

/** Classic incremental step test: equal steps, equal increments. */
export function buildStepTest(options: StepTestOptions): Step[] {
  const steps: Step[] = []
  if (options.warmupDurationS) {
    steps.push({
      id: newId('step'),
      name: 'Warm-up',
      durationS: options.warmupDurationS,
      target: { mode: 'watts', watts: options.warmupWatts ?? options.startWatts - options.stepWatts },
    })
  }
  for (let i = 0; i < options.stepCount; i++) {
    steps.push({
      id: newId('step'),
      name: `Step ${i + 1}`,
      durationS: options.stepDurationS,
      target: { mode: 'watts', watts: options.startWatts + i * options.stepWatts },
      lactateSample: !!options.sampleBreakS,
      recoveryS: options.sampleBreakS,
    })
  }
  return steps
}

export interface RampOptions {
  startWatts: number
  wattsPerMinute: number
  durationS: number
  /** Ramps are drawn as one-minute stairs, matching how trainers apply them. */
  stairS?: number
}

/** Ramp test expressed as fine stairs, so laps stay readable. */
export function buildRamp(options: RampOptions): Step[] {
  const stair = options.stairS ?? 60
  const count = Math.max(1, Math.round(options.durationS / stair))
  const perStair = (options.wattsPerMinute * stair) / 60
  return Array.from({ length: count }, (_, i) => ({
    id: newId('step'),
    name: `Step ${i + 1}`,
    durationS: stair,
    target: { mode: 'watts' as const, watts: Math.round(options.startWatts + i * perStair) },
  }))
}

export interface RunStepTestOptions {
  startKph: number
  stepKph: number
  stepDurationS: number
  stepCount: number
  inclinePct?: number
  sampleBreakS?: number
}

export function buildRunStepTest(options: RunStepTestOptions): Step[] {
  return Array.from({ length: options.stepCount }, (_, i) => ({
    id: newId('step'),
    name: `Step ${i + 1}`,
    durationS: options.stepDurationS,
    target: {
      mode: 'speed' as const,
      kph: Number((options.startKph + i * options.stepKph).toFixed(2)),
      inclinePct: options.inclinePct,
    },
    lactateSample: !!options.sampleBreakS,
    recoveryS: options.sampleBreakS,
  }))
}

/**
 * The prescribed target at 1 Hz across the whole protocol, including sampling
 * breaks. Used both to draw the plan trace and to compute the plan's own
 * mean-maximal curve, so the two can never drift apart.
 */
export function planPowerSeries(protocol: Protocol, ftpWatts: number): number[] {
  const series: number[] = []
  for (const step of protocol.steps) {
    for (let t = 0; t < step.durationS; t++) {
      const watts = targetWattsAt(step, t, ftpWatts)
      series.push(watts === null ? 0 : Math.round(watts))
    }
    const breakWatts = recoveryWatts(step, protocol, ftpWatts)
    for (let t = 0; t < (step.recoveryS ?? 0); t++) {
      series.push(isControlled(step) ? breakWatts : 0)
    }
  }
  return series
}

/** The prescribed treadmill speed at 1 Hz, in km/h. */
export function planSpeedSeries(protocol: Protocol, economyPct = 100): number[] {
  const series: number[] = []
  for (const step of protocol.steps) {
    for (let t = 0; t < step.durationS; t++) {
      const kph = targetKphAt(step, t, economyPct)
      series.push(kph === null ? 0 : kph)
    }
    for (let t = 0; t < (step.recoveryS ?? 0); t++) series.push(0)
  }
  return series
}

/** Start second of each step, for drawing step boundaries on the timeline. */
export function stepBoundaries(protocol: Protocol): number[] {
  const marks: number[] = []
  let t = 0
  for (const step of protocol.steps) {
    marks.push(t)
    t += stepTotalS(step)
  }
  return marks
}

// --- repetition -----------------------------------------------------------

/**
 * Copies a block of steps `times` times over, giving every copy fresh ids.
 *
 * Repeats are expanded when the protocol is written, not carried as a count on
 * the step. The runner, the lap table and the journal all address steps by
 * index, and a step that secretly stands for six would make every one of those
 * lie. The cost is that editing one repetition afterwards does not change its
 * siblings, which is visible and fixable, unlike a wrong lap index.
 */
export function repeatBlock(block: readonly Step[], times: number): Step[] {
  const count = Math.max(1, Math.floor(times))
  const out: Step[] = []
  for (let rep = 0; rep < count; rep++) {
    for (const step of block) {
      out.push({ ...step, id: newId('step'), target: { ...step.target } })
    }
  }
  return out
}

/** Numbers repeated steps so a lap table stays readable: "4 min work 3/6". */
export function numberRepeats(block: readonly Step[], times: number): Step[] {
  const count = Math.max(1, Math.floor(times))
  const out: Step[] = []
  for (let rep = 0; rep < count; rep++) {
    for (const step of block) {
      out.push({
        ...step,
        id: newId('step'),
        target: { ...step.target },
        name: count > 1 ? `${step.name ?? 'Step'} ${rep + 1}/${count}` : step.name,
      })
    }
  }
  return out
}

export interface IntervalOptions {
  /** Repetitions inside one set. */
  reps: number
  onDurationS: number
  onTarget: StepTarget
  offDurationS: number
  offTarget: StepTarget
  /** Sets of the whole rep block. Defaults to one. */
  sets?: number
  /** Recovery between sets, in seconds. */
  setRecoveryS?: number
  setRecoveryTarget?: StepTarget
  name?: string
}

/**
 * An interval session written once and expanded: reps inside sets, with an
 * optional longer recovery between sets. This is the thing that previously had
 * to be typed out rep by rep.
 */
export function buildIntervals(options: IntervalOptions): Step[] {
  const sets = Math.max(1, Math.floor(options.sets ?? 1))
  const reps = Math.max(1, Math.floor(options.reps))
  const label = options.name ?? 'Interval'
  const steps: Step[] = []

  for (let set = 0; set < sets; set++) {
    for (let rep = 0; rep < reps; rep++) {
      const suffix = sets > 1 ? `${set + 1}.${rep + 1}` : `${rep + 1}/${reps}`
      steps.push({
        id: newId('step'),
        name: `${label} ${suffix}`,
        durationS: options.onDurationS,
        target: { ...options.onTarget },
      })
      // The last rest of the last set is dropped: a session should not end on
      // an easy spin nobody asked for.
      const isFinal = set === sets - 1 && rep === reps - 1
      if (options.offDurationS > 0 && !isFinal) {
        steps.push({
          id: newId('step'),
          name: `Rest ${suffix}`,
          durationS: options.offDurationS,
          target: { ...options.offTarget },
        })
      }
    }
    if (set < sets - 1 && options.setRecoveryS) {
      steps.push({
        id: newId('step'),
        name: `Set recovery ${set + 1}`,
        durationS: options.setRecoveryS,
        target: { ...(options.setRecoveryTarget ?? options.offTarget) },
      })
    }
  }

  return steps
}

export function makeProtocol(
  name: string,
  sport: Sport,
  steps: Step[],
  description?: string,
  recovery?: RecoveryTarget,
): Protocol {
  const now = Date.now()
  return {
    id: newId('proto'),
    name,
    description,
    sport,
    steps,
    recovery,
    createdAt: now,
    updatedAt: now,
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
