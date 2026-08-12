export type Sport = 'bike' | 'run'

export type StepTarget =
  /** Absolute watts. */
  | { mode: 'watts'; watts: number; toWatts?: number }
  /** Watts as a percentage of the athlete's threshold power. */
  | { mode: 'ftp'; pctFtp: number; toPctFtp?: number }
  /** Treadmill pace, optionally with a gradient. */
  | { mode: 'speed'; kph: number; toKph?: number; inclinePct?: number }
  /** No machine control: the athlete rides or runs to feel. */
  | { mode: 'free' }

export interface Step {
  id: string
  name?: string
  durationS: number
  target: StepTarget
  /** Pause the clock at the end of this step for a blood sample. */
  lactateSample?: boolean
  /** Unpaced break appended to the step, e.g. 30 s to draw blood. */
  recoveryS?: number
  notes?: string
}

export interface Protocol {
  id: string
  name: string
  description?: string
  sport: Sport
  steps: Step[]
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
}

export const DEFAULT_ATHLETE: Athlete = {
  name: 'Athlete',
  massKg: 75,
  ftpWatts: 300,
  maxHr: 190,
  restingHr: 50,
}

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

/** Target at a point inside a step, in km/h. */
export function targetKphAt(step: Step, elapsedInStepS: number): number | null {
  if (step.target.mode !== 'speed') return null
  const t = step.durationS > 0 ? clamp01(elapsedInStepS / step.durationS) : 0
  return lerp(step.target.kph, step.target.toKph ?? step.target.kph, t)
}

/** Nominal intensity of a step, used for labels and the plan trace. */
export function stepLabel(step: Step, ftpWatts: number): string {
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
export function planPowerSeries(protocol: Protocol, ftpWatts: number, breakWatts = 0): number[] {
  const series: number[] = []
  for (const step of protocol.steps) {
    for (let t = 0; t < step.durationS; t++) {
      const watts = targetWattsAt(step, t, ftpWatts)
      series.push(watts === null ? 0 : Math.round(watts))
    }
    for (let t = 0; t < (step.recoveryS ?? 0); t++) {
      series.push(isControlled(step) ? breakWatts : 0)
    }
  }
  return series
}

/** The prescribed treadmill speed at 1 Hz, in km/h. */
export function planSpeedSeries(protocol: Protocol): number[] {
  const series: number[] = []
  for (const step of protocol.steps) {
    for (let t = 0; t < step.durationS; t++) {
      const kph = targetKphAt(step, t)
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

export function makeProtocol(
  name: string,
  sport: Sport,
  steps: Step[],
  description?: string,
): Protocol {
  const now = Date.now()
  return { id: newId('proto'), name, description, sport, steps, createdAt: now, updatedAt: now }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
