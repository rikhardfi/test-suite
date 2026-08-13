/**
 * Lactate curve fitting and threshold estimation.
 *
 * Every method here operates on the same shape — intensity (watts or km/h)
 * against blood lactate — so bike and treadmill tests share one implementation.
 * Methods disagree by design: reporting several side by side is the point.
 */

import { mean } from './metrics'

export interface LactatePoint {
  intensity: number
  lactate: number
  heartRate?: number
}

export interface ThresholdResult {
  method: string
  label: string
  intensity: number | null
  heartRate: number | null
  lactate: number | null
  note?: string
}

// --- least squares --------------------------------------------------------

/** Polynomial least-squares fit; returns coefficients in ascending order. */
export function polyfit(x: readonly number[], y: readonly number[], degree: number): number[] {
  const n = Math.min(x.length, y.length)
  if (n < degree + 1) throw new Error(`polyfit: need at least ${degree + 1} points, got ${n}`)

  const size = degree + 1
  // Normal equations: (VᵀV) c = Vᵀy, built directly from power sums.
  const powerSums = new Array(2 * degree + 1).fill(0)
  for (let i = 0; i < n; i++) {
    let p = 1
    for (let k = 0; k <= 2 * degree; k++) {
      powerSums[k] += p
      p *= x[i]
    }
  }

  const rhs = new Array(size).fill(0)
  for (let i = 0; i < n; i++) {
    let p = 1
    for (let k = 0; k < size; k++) {
      rhs[k] += y[i] * p
      p *= x[i]
    }
  }

  const matrix: number[][] = []
  for (let r = 0; r < size; r++) {
    const row = new Array(size + 1)
    for (let c = 0; c < size; c++) row[c] = powerSums[r + c]
    row[size] = rhs[r]
    matrix.push(row)
  }
  return solve(matrix)
}

/** Gaussian elimination with partial pivoting on an augmented matrix. */
function solve(matrix: number[][]): number[] {
  const n = matrix.length
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) throw new Error('polyfit: singular system')
    ;[matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]]

    for (let row = col + 1; row < n; row++) {
      const factor = matrix[row][col] / matrix[col][col]
      for (let c = col; c <= n; c++) matrix[row][c] -= factor * matrix[col][c]
    }
  }

  const out = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = matrix[row][n]
    for (let c = row + 1; c < n; c++) sum -= matrix[row][c] * out[c]
    out[row] = sum / matrix[row][row]
  }
  return out
}

export const polyval = (coefficients: readonly number[], x: number): number =>
  coefficients.reduce((sum, c, i) => sum + c * x ** i, 0)

/** Ordinary least squares for y = slope·x + intercept. */
export function linearFit(
  x: readonly number[],
  y: readonly number[],
): { slope: number; intercept: number; r2: number } {
  const n = Math.min(x.length, y.length)
  if (n < 2) throw new Error('linearFit: need at least 2 points')

  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n

  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0) throw new Error('linearFit: zero variance in x')

  const slope = sxy / sxx
  return { slope, intercept: meanY - slope * meanX, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) }
}

// --- curve helpers --------------------------------------------------------

const SCAN_STEPS = 2000

export function sortPoints(points: readonly LactatePoint[]): LactatePoint[] {
  return [...points]
    .filter((p) => Number.isFinite(p.intensity) && Number.isFinite(p.lactate))
    .sort((a, b) => a.intensity - b.intensity)
}

/** Third-order fit of lactate against intensity, the conventional choice. */
export function fitLactateCurve(points: readonly LactatePoint[]): number[] | null {
  const sorted = sortPoints(points)
  if (sorted.length < 4) return null
  try {
    return polyfit(
      sorted.map((p) => p.intensity),
      sorted.map((p) => p.lactate),
      3,
    )
  } catch {
    return null
  }
}

/** Smooth curve for plotting. */
export function curveSamples(
  points: readonly LactatePoint[],
  steps = 120,
): { intensity: number; lactate: number }[] {
  const sorted = sortPoints(points)
  const coefficients = fitLactateCurve(sorted)
  if (!coefficients || sorted.length < 2) return []
  const lo = sorted[0].intensity
  const hi = sorted[sorted.length - 1].intensity
  return Array.from({ length: steps + 1 }, (_, i) => {
    const intensity = lo + ((hi - lo) * i) / steps
    return { intensity, lactate: polyval(coefficients, intensity) }
  })
}

/** Linear interpolation of heart rate at an arbitrary intensity. */
export function heartRateAt(points: readonly LactatePoint[], intensity: number): number | null {
  const withHr = sortPoints(points).filter((p) => typeof p.heartRate === 'number')
  if (withHr.length === 0) return null
  if (withHr.length === 1) return Math.round(withHr[0].heartRate as number)

  if (intensity <= withHr[0].intensity) return Math.round(withHr[0].heartRate as number)
  const last = withHr[withHr.length - 1]
  if (intensity >= last.intensity) return Math.round(last.heartRate as number)

  for (let i = 1; i < withHr.length; i++) {
    const a = withHr[i - 1]
    const b = withHr[i]
    if (intensity <= b.intensity) {
      const t = (intensity - a.intensity) / (b.intensity - a.intensity)
      return Math.round((a.heartRate as number) + t * ((b.heartRate as number) - (a.heartRate as number)))
    }
  }
  return null
}

/**
 * Intensity at which the fitted curve first reaches a lactate concentration.
 * Scanning rather than root-finding keeps it robust when the cubic wiggles.
 */
export function intensityAtLactate(
  points: readonly LactatePoint[],
  targetMmol: number,
): number | null {
  const sorted = sortPoints(points)
  if (sorted.length < 2) return null
  const coefficients = fitLactateCurve(sorted)
  const lo = sorted[0].intensity
  const hi = sorted[sorted.length - 1].intensity

  const valueAt = coefficients
    ? (x: number) => polyval(coefficients, x)
    : (x: number) => interpolateLinear(sorted, x)

  if (valueAt(hi) < targetMmol) return null
  if (valueAt(lo) > targetMmol) return null

  let previousX = lo
  let previousY = valueAt(lo)
  for (let i = 1; i <= SCAN_STEPS; i++) {
    const x = lo + ((hi - lo) * i) / SCAN_STEPS
    const y = valueAt(x)
    if (previousY <= targetMmol && y >= targetMmol) {
      const t = y === previousY ? 0 : (targetMmol - previousY) / (y - previousY)
      return previousX + t * (x - previousX)
    }
    previousX = x
    previousY = y
  }
  return null
}

function interpolateLinear(sorted: readonly LactatePoint[], x: number): number {
  if (x <= sorted[0].intensity) return sorted[0].lactate
  const last = sorted[sorted.length - 1]
  if (x >= last.intensity) return last.lactate
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (x <= b.intensity) {
      const t = (x - a.intensity) / (b.intensity - a.intensity)
      return a.lactate + t * (b.lactate - a.lactate)
    }
  }
  return last.lactate
}

// --- threshold methods ----------------------------------------------------

/** Fixed blood lactate concentration, e.g. OBLA 4 mmol/L. */
export function obla(points: readonly LactatePoint[], mmol: number): ThresholdResult {
  const intensity = intensityAtLactate(points, mmol)
  return {
    method: `obla${mmol}`,
    label: `OBLA ${mmol.toFixed(1)} mmol/L`,
    intensity,
    heartRate: intensity === null ? null : heartRateAt(points, intensity),
    lactate: intensity === null ? null : mmol,
    note: intensity === null ? 'Test did not span this concentration' : undefined,
  }
}

/** Baseline plus a fixed rise, the usual pragmatic LT1. */
export function baselinePlus(points: readonly LactatePoint[], delta: number): ThresholdResult {
  const sorted = sortPoints(points)
  if (sorted.length < 3) {
    return emptyResult(`baseline+${delta}`, `Baseline + ${delta.toFixed(1)} mmol/L`)
  }
  const baseline = Math.min(...sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 3))).map((p) => p.lactate))
  const target = baseline + delta
  const intensity = intensityAtLactate(sorted, target)
  return {
    method: `baseline+${delta}`,
    label: `Baseline + ${delta.toFixed(1)} mmol/L`,
    intensity,
    heartRate: intensity === null ? null : heartRateAt(sorted, intensity),
    lactate: intensity === null ? null : target,
    note: `Baseline ${baseline.toFixed(2)} mmol/L`,
  }
}

/**
 * Dmax: the point on the fitted curve furthest from the chord joining its two
 * endpoints. Modified Dmax anchors the chord at LT1 instead of the first
 * point, which stops a long easy warm-up from dragging the estimate down.
 */
export function dmax(points: readonly LactatePoint[], modified = false): ThresholdResult {
  const method = modified ? 'modDmax' : 'dmax'
  const label = modified ? 'Modified Dmax' : 'Dmax'
  const sorted = sortPoints(points)
  const coefficients = fitLactateCurve(sorted)
  if (!coefficients) return emptyResult(method, label, 'Needs at least 4 lactate samples')

  const lastPoint = sorted[sorted.length - 1]
  let anchor = sorted[0]

  if (modified) {
    // LT1 by the conventional rule: the first stage whose lactate rises more
    // than 0.4 mmol/L above the preceding stage.
    const rise = sorted.findIndex((p, i) => i > 0 && p.lactate - sorted[i - 1].lactate > 0.4)
    if (rise <= 0) return emptyResult(method, label, 'No clear first rise in lactate')
    anchor = sorted[rise]
  }

  const x1 = anchor.intensity
  const y1 = polyval(coefficients, x1)
  const x2 = lastPoint.intensity
  const y2 = polyval(coefficients, x2)
  if (x2 <= x1) return emptyResult(method, label, 'Not enough intensity range')

  // Perpendicular distance to the chord, maximised over the fitted curve.
  const a = y2 - y1
  const b = -(x2 - x1)
  const c = -(a * x1 + b * y1)
  const norm = Math.hypot(a, b)

  let bestX = x1
  let bestDistance = -Infinity
  for (let i = 0; i <= SCAN_STEPS; i++) {
    const x = x1 + ((x2 - x1) * i) / SCAN_STEPS
    const distance = Math.abs(a * x + b * polyval(coefficients, x) + c) / norm
    if (distance > bestDistance) {
      bestDistance = distance
      bestX = x
    }
  }

  return {
    method,
    label,
    intensity: bestX,
    heartRate: heartRateAt(sorted, bestX),
    lactate: polyval(coefficients, bestX),
    note: modified ? `Anchored at ${Math.round(anchor.intensity)}` : undefined,
  }
}

/**
 * Log-log LT1: the breakpoint of two straight lines fitted to log lactate
 * against log intensity, chosen by minimum combined residual.
 */
export function logLogLt1(points: readonly LactatePoint[]): ThresholdResult {
  const method = 'loglog'
  const label = 'Log-log LT1'
  const sorted = sortPoints(points).filter((p) => p.intensity > 0 && p.lactate > 0)
  if (sorted.length < 5) return emptyResult(method, label, 'Needs at least 5 positive samples')

  const logX = sorted.map((p) => Math.log(p.intensity))
  const logY = sorted.map((p) => Math.log(p.lactate))

  let best: { index: number; sse: number } | null = null
  for (let split = 2; split <= sorted.length - 3; split++) {
    try {
      const left = linearFit(logX.slice(0, split + 1), logY.slice(0, split + 1))
      const right = linearFit(logX.slice(split), logY.slice(split))
      const sse =
        residual(logX.slice(0, split + 1), logY.slice(0, split + 1), left) +
        residual(logX.slice(split), logY.slice(split), right)
      if (!best || sse < best.sse) best = { index: split, sse }
    } catch {
      // Degenerate segment, try the next split.
    }
  }
  if (!best) return emptyResult(method, label, 'Could not find a breakpoint')

  const point = sorted[best.index]
  return {
    method,
    label,
    intensity: point.intensity,
    heartRate: point.heartRate ?? heartRateAt(sorted, point.intensity),
    lactate: point.lactate,
    note: 'Breakpoint falls on a measured stage',
  }
}

function residual(
  x: readonly number[],
  y: readonly number[],
  fit: { slope: number; intercept: number },
): number {
  let sum = 0
  for (let i = 0; i < x.length; i++) {
    const error = y[i] - (fit.slope * x[i] + fit.intercept)
    sum += error * error
  }
  return sum
}

/** Runs every applicable method over one test. */
export function analyseLactate(points: readonly LactatePoint[]): ThresholdResult[] {
  const sorted = sortPoints(points)
  return [
    baselinePlus(sorted, 1.0),
    logLogLt1(sorted),
    dmax(sorted, false),
    dmax(sorted, true),
    obla(sorted, 2.0),
    obla(sorted, 4.0),
  ]
}

// --- critical power -------------------------------------------------------

export interface CriticalPowerResult {
  cpWatts: number
  wPrimeJoules: number
  r2: number
  usedDurations: number[]
}

/**
 * Two-parameter critical power from a mean-maximal curve, fitted as the linear
 * work–time model W = CP·t + W′.
 *
 * Only efforts between two and twenty minutes are used: shorter ones are
 * dominated by W′ and longer ones by fatigue the model does not describe.
 */
export function criticalPower(
  curve: readonly { durationS: number; watts: number }[],
  range: { minS?: number; maxS?: number } = {},
): CriticalPowerResult | null {
  const minS = range.minS ?? 120
  const maxS = range.maxS ?? 1200
  const usable = curve
    .filter((p) => p.durationS >= minS && p.durationS <= maxS && p.watts > 0)
    .sort((a, b) => a.durationS - b.durationS)
  if (usable.length < 3) return null

  const t = usable.map((p) => p.durationS)
  const work = usable.map((p) => p.watts * p.durationS)
  try {
    const fit = linearFit(t, work)
    if (fit.slope <= 0 || fit.intercept <= 0) return null
    return {
      cpWatts: fit.slope,
      wPrimeJoules: fit.intercept,
      r2: fit.r2,
      usedDurations: t,
    }
  } catch {
    return null
  }
}

const emptyResult = (method: string, label: string, note?: string): ThresholdResult => ({
  method,
  label,
  intensity: null,
  heartRate: null,
  lactate: null,
  note,
})

// --- W′ balance -------------------------------------------------------------

/**
 * W′ balance over a power series, by the differential model.
 *
 * Above critical power the athlete spends W′ at the rate they exceed it. Below
 * it, W′ refills at a rate proportional both to how far below they are and to
 * how much is still missing, which is why recovery slows as the tank fills.
 *
 * This is Skiba's integral-free form. It is a model, not a measurement, and it
 * is only as good as the CP and W′ it is given: run it on a fit from a
 * submaximal step test and it will produce a confident number that means
 * nothing. The dashboard hides it when there is no valid fit rather than
 * showing a plausible one.
 */
export function wPrimeBalance(
  power: readonly number[],
  cpWatts: number,
  wPrimeJoules: number,
  dtS = 1,
): number[] {
  if (!(cpWatts > 0) || !(wPrimeJoules > 0)) return []
  const out: number[] = []
  let balance = wPrimeJoules
  for (const watts of power) {
    const w = Number.isFinite(watts) ? watts : 0
    if (w > cpWatts) {
      balance -= (w - cpWatts) * dtS
    } else {
      balance += ((wPrimeJoules - balance) * (cpWatts - w) * dtS) / wPrimeJoules
    }
    balance = Math.min(wPrimeJoules, Math.max(0, balance))
    out.push(balance)
  }
  return out
}

// --- aerobic decoupling -----------------------------------------------------

export interface DecouplingResult {
  /** Percentage drift in output per heartbeat between the halves. */
  pctDrift: number
  firstHalfRatio: number
  secondHalfRatio: number
}

/**
 * Aerobic decoupling across a steady block: the output-to-heart-rate ratio in
 * the first half against the second.
 *
 * A step test is made of exactly the steady blocks this is computable over, and
 * every sample already carries the step it belongs to. It means nothing over a
 * short stage or a ramp, so callers are expected to apply a minimum duration
 * and this returns null when there is not enough on either side to compare.
 */
export function decoupling(
  output: readonly number[],
  heartRate: readonly number[],
  minSamplesPerHalf = 60,
): DecouplingResult | null {
  const n = Math.min(output.length, heartRate.length)
  const half = Math.floor(n / 2)
  if (half < minSamplesPerHalf) return null

  const ratio = (from: number, to: number): number | null => {
    const out: number[] = []
    const hr: number[] = []
    for (let i = from; i < to; i++) {
      if (!Number.isFinite(output[i]) || !Number.isFinite(heartRate[i])) continue
      if (heartRate[i] <= 0) continue
      out.push(output[i])
      hr.push(heartRate[i])
    }
    if (out.length < minSamplesPerHalf) return null
    const meanHr = mean(hr)
    return meanHr > 0 ? mean(out) / meanHr : null
  }

  const first = ratio(0, half)
  const second = ratio(half, n)
  if (first === null || second === null || first === 0) return null

  return {
    pctDrift: ((second - first) / first) * 100,
    firstHalfRatio: first,
    secondHalfRatio: second,
  }
}
