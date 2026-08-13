/** Durations, in seconds, plotted on the mean-maximal power curve. */
export const MMP_DURATIONS = [
  1, 5, 10, 15, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600,
] as const

/** Simple trailing average over a fixed number of 1 Hz samples. */
export class RollingAverage {
  private readonly buffer: number[] = []
  private sum = 0

  constructor(private readonly windowSize: number) {}

  push(value: number): number {
    this.buffer.push(value)
    this.sum += value
    if (this.buffer.length > this.windowSize) {
      this.sum -= this.buffer.shift() as number
    }
    return this.value
  }

  get value(): number {
    return this.buffer.length ? this.sum / this.buffer.length : 0
  }

  /** True once the window is actually full, so partial averages can be hidden. */
  get isFull(): boolean {
    return this.buffer.length >= this.windowSize
  }

  reset(): void {
    this.buffer.length = 0
    this.sum = 0
  }
}

/**
 * Best average power for each tracked duration, maintained incrementally.
 *
 * A prefix sum over the 1 Hz power series makes every window a subtraction, so
 * the whole curve costs one pass per sample regardless of ride length.
 */
export class MmpTracker {
  private prefix: number[] = [0]
  private best = new Map<number, number>()

  constructor(private readonly durations: readonly number[] = MMP_DURATIONS) {}

  push(power: number): void {
    const prefix = this.prefix
    prefix.push(prefix[prefix.length - 1] + power)
    const n = prefix.length - 1

    for (const d of this.durations) {
      if (n < d) break
      const mean = (prefix[n] - prefix[n - d]) / d
      const current = this.best.get(d)
      if (current === undefined || mean > current) this.best.set(d, mean)
    }
  }

  /** Points for plotting, ascending by duration; only completed durations. */
  curve(): { durationS: number; watts: number }[] {
    return this.durations
      .filter((d) => this.best.has(d))
      .map((d) => ({ durationS: d, watts: this.best.get(d) as number }))
  }

  get(durationS: number): number | null {
    return this.best.get(durationS) ?? null
  }

  reset(): void {
    this.prefix = [0]
    this.best.clear()
  }
}

/** Mean-maximal curve of a finished power series. */
export function mmpCurve(
  power: readonly number[],
  durations: readonly number[] = MMP_DURATIONS,
): { durationS: number; watts: number }[] {
  const tracker = new MmpTracker(durations)
  for (const p of power) tracker.push(p)
  return tracker.curve()
}

/**
 * Normalised power: fourth root of the mean of the fourth power of a 30 s
 * rolling average. Undefined for efforts shorter than the window.
 */
export function normalizedPower(power: readonly number[]): number | null {
  if (power.length < 30) return null
  const window = new RollingAverage(30)
  let sum = 0
  let count = 0
  for (const p of power) {
    const avg = window.push(p)
    if (window.isFull) {
      sum += avg ** 4
      count++
    }
  }
  return count ? (sum / count) ** 0.25 : null
}

/**
 * Beat-to-beat variability over a window of RR intervals.
 *
 * Both measures are standard and both are only interpretable at rest or in
 * recovery. During hard exercise the beat-to-beat signal is dominated by
 * mechanical and respiratory artefact rather than by autonomic tone, so a
 * number computed mid-stage is real arithmetic on a meaningless input. The
 * interface has to say which window it covers; this function only refuses to
 * answer when there are too few beats to answer at all.
 */
export interface HrvResult {
  /** Root mean square of successive differences, ms. */
  rmssd: number
  /** Standard deviation of the intervals, ms. */
  sdnn: number
  /** Beats the window actually contained. */
  beats: number
  /** Mean heart rate over the window, for judging whether any of it applies. */
  meanHr: number
}

/** Physiologically impossible intervals, which straps emit on a dropped beat. */
const RR_MIN_MS = 250
const RR_MAX_MS = 2000
const HRV_MIN_BEATS = 20

export function hrv(intervalsMs: readonly number[]): HrvResult | null {
  const rr = intervalsMs.filter((ms) => Number.isFinite(ms) && ms >= RR_MIN_MS && ms <= RR_MAX_MS)
  if (rr.length < HRV_MIN_BEATS) return null

  let sumSquaredDiff = 0
  for (let i = 1; i < rr.length; i++) sumSquaredDiff += (rr[i] - rr[i - 1]) ** 2
  const rmssd = Math.sqrt(sumSquaredDiff / (rr.length - 1))

  const avg = mean(rr)
  const variance = mean(rr.map((ms) => (ms - avg) ** 2))

  return {
    rmssd,
    sdnn: Math.sqrt(variance),
    beats: rr.length,
    meanHr: avg > 0 ? 60000 / avg : 0,
  }
}

export const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0

export const max = (values: readonly number[]): number =>
  values.length ? values.reduce((a, b) => (b > a ? b : a), values[0]) : 0

/** Pace as mm:ss per kilometre from a speed in m/s. */
export function paceFromSpeed(speedMs: number): string {
  if (!speedMs || speedMs <= 0.1) return '—'
  const secondsPerKm = 1000 / speedMs
  const minutes = Math.floor(secondsPerKm / 60)
  const seconds = Math.round(secondsPerKm % 60)
  return seconds === 60 ? `${minutes + 1}:00` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Time remaining, rounded up. A countdown that floors shows 0:00 for a whole
 * second before the step actually ends, which reads as a stalled clock.
 */
export const formatCountdown = (secondsLeft: number): string =>
  formatClock(Math.ceil(Math.max(0, secondsLeft)))

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, '0')
  return hours
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`
}
