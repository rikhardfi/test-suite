/**
 * Exhalations from the TSI meter's rows, live.
 *
 * A port of `tsi_segments()` and the late-plateau reading of
 * `tsi_breath_energy()` in the ventilation project (`R/tsi.R`), gate for gate
 * and constant for constant, so that a breath counted here is the breath the
 * analysis counts afterwards. Change one and the other has to change with it.
 * The method, and why the plateau is read from 50 to 90 % of the exhalation
 * rather than at its peak or at reversal, is in that project's
 * `docs/method/tsi_breath_energy.md`.
 *
 * Batch, not incremental: the caller keeps the last few tens of seconds of rows
 * and runs this over them, the same algorithm the analysis runs over a whole
 * session. Breaths touching either end of what it is given are left out,
 * because at the end they are still in progress and at the start they are cut.
 *
 * Pure.
 */

/** `cfg$tsi` in the ventilation project. */
export const BREATH_SETTINGS = {
  minPeakFlowLMin: 2,
  minDurationS: 0.3,
  minVolumeL: 0.05,
  maxPauseS: 0.5,
  flipThresholdLMin: 50,
  plateauFrom: 0.5,
  plateauTo: 0.9,
  rhSaturatedPct: 99.5,
  /**
   * Longer or larger "exhalations" are fan or dryer flow, not breath
   * (`cfg$tsi$report$max_breath_s` and `max_breath_l`).
   */
  maxBreathS: 8,
  maxBreathL: 8,
} as const

export interface FlowRows {
  /** Std L/min, positive exhaled. NaN where the meter sent nothing. */
  flow: readonly number[]
  tempC: readonly number[]
  rhPct: readonly number[]
  pressureKpa: readonly number[]
  /** Grid step, s. */
  dtS: number
  /** Wall-clock time of the first row, ms. */
  t0: number
}

export interface Exhalation {
  /** Wall clock, ms. */
  startAt: number
  endAt: number
  durationS: number
  /** Std L: dry gas at 21.11 °C and 101.325 kPa. */
  volumeStdL: number
  /** Mean absolute pressure at the meter over the exhalation, Pa. */
  pressurePa: number
  /** Gas temperature and RH on the late plateau. */
  tempC: number
  rhPct: number
  /** RH at or above 99.5 % on the plateau: condensation, RH set to 100. */
  saturated: boolean
}

/** `tsi_fix_direction_flips()`: a sign change between two large flows is the meter's direction sensor, not the breath. */
export function fixDirectionFlips(flow: readonly number[], threshold: number = BREATH_SETTINGS.flipThresholdLMin): number[] {
  const out = flow.slice()
  const n = out.length
  const flips: number[] = []
  for (let k = 1; k < n; k++) {
    const a = flow[k - 1]
    const z = flow[k]
    if (Number.isFinite(a) && Number.isFinite(z) && Math.sign(a) !== Math.sign(z) && Math.abs(a) > threshold && Math.abs(z) > threshold) {
      flips.push(k)
    }
  }
  for (const k of flips) {
    const ref = Math.abs(out[k])
    let e = n - 1
    for (let j = k; j < n; j++) {
      const m = Math.abs(out[j])
      if (!Number.isFinite(m)) continue
      const prev = j === k ? Infinity : Math.abs(out[j - 1])
      const next = j === n - 1 ? Infinity : Math.abs(out[j + 1])
      // A missing neighbour fails the comparison, as NA does in R.
      if (m <= threshold || (m < 0.25 * ref && m <= prev && m <= next)) {
        e = j - 1
        break
      }
    }
    for (let j = k; j <= e; j++) out[j] = -out[j]
  }
  return out
}

interface Segment {
  direction: number
  i0: number
  i1: number
  strong: boolean
}

/**
 * Exhalations in the rows, excluding any that touch the first or last row and
 * any too long or too large to be a breath (`tsi_report.R`'s `plausible`).
 */
export function exhalations(rows: FlowRows, settings = BREATH_SETTINGS): Exhalation[] {
  const n = rows.flow.length
  if (n < 2) return []
  const flow = fixDirectionFlips(rows.flow, settings.flipThresholdLMin)
  const dt = rows.dtS

  const measure = (s: Segment): Segment => {
    let volume = 0
    let peak = 0
    for (let i = s.i0; i <= s.i1; i++) {
      const v = Math.abs(flow[i])
      if (!Number.isFinite(v)) continue
      volume += v
      if (v > peak) peak = v
    }
    volume *= dt / 60
    const duration = (s.i1 - s.i0 + 1) * dt
    return {
      ...s,
      strong:
        s.direction !== 0 &&
        peak >= settings.minPeakFlowLMin &&
        duration >= settings.minDurationS &&
        volume >= settings.minVolumeL,
    }
  }

  // Runs of one sign; missing rows are sign 0, like a pause.
  const runs: Segment[] = []
  for (let i = 0; i < n; i++) {
    const d = Number.isFinite(flow[i]) ? Math.sign(flow[i]) : 0
    const last = runs[runs.length - 1]
    if (last && last.direction === d) last.i1 = i
    else runs.push({ direction: d, i0: i, i1: i, strong: false })
  }

  // Strong breaths of one direction separated only by a short weak stretch are
  // one breath. Merging left to right is what the R loop's repeated
  // first-pair merge comes to.
  const strong: Segment[] = []
  for (const run of runs.map(measure)) {
    if (!run.strong) continue
    const prev = strong[strong.length - 1]
    const pauseS = prev ? (run.i0 - prev.i1 - 1) * dt : Infinity
    if (prev && prev.direction === run.direction && run.i0 > prev.i1 + 1 && pauseS <= settings.maxPauseS) {
      strong[strong.length - 1] = measure({ ...prev, i1: run.i1 })
    } else {
      strong.push(run)
    }
  }

  const out: Exhalation[] = []
  for (const s of strong) {
    if (s.direction <= 0 || s.i0 === 0 || s.i1 === n - 1) continue
    const len = s.i1 - s.i0 + 1
    if (len * dt >= settings.maxBreathS) continue
    let a = s.i0 + Math.floor(settings.plateauFrom * len)
    const z = Math.min(s.i1, s.i0 + Math.ceil(settings.plateauTo * len) - 1)
    if (z < a) a = z
    let volume = 0
    for (let i = s.i0; i <= s.i1; i++) if (Number.isFinite(flow[i])) volume += Math.abs(flow[i])
    const tempC = meanOf(rows.tempC, a, z)
    const rhRaw = rows.rhPct.slice(a, z + 1)
    const rhPct = meanOf(rhRaw.map((v) => Math.min(v, 100)), 0, rhRaw.length - 1)
    const pressureKpa = meanOf(rows.pressureKpa, s.i0, s.i1)
    if (tempC == null || rhPct == null || pressureKpa == null) continue
    if ((volume * dt) / 60 >= settings.maxBreathL) continue
    out.push({
      startAt: rows.t0 + s.i0 * dt * 1000,
      endAt: rows.t0 + (s.i1 + 1) * dt * 1000,
      durationS: len * dt,
      volumeStdL: (volume * dt) / 60,
      pressurePa: pressureKpa * 1000,
      tempC,
      rhPct,
      saturated: rhRaw.some((v) => v >= settings.rhSaturatedPct),
    })
  }
  return out
}

function meanOf(values: readonly number[], from: number, to: number): number | null {
  let sum = 0
  let count = 0
  for (let i = from; i <= to; i++) {
    const v = values[i]
    if (Number.isFinite(v)) {
      sum += v
      count += 1
    }
  }
  return count ? sum / count : null
}
