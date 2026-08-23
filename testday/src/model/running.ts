import { mmpCurve } from './metrics'
import { computeVo2, solveSpeedForVo2 } from './vo2'
import type { Sample } from './session'

/**
 * The running analogues of the power curve.
 *
 * A mean-maximal *power* curve on a treadmill is a curve of zeroes, and a
 * mean-maximal *speed* curve is not much better on a test that changes the
 * gradient: 10 km/h at 12% and 15 km/h on the flat are the same effort and the
 * raw curve calls the second one twice the first. So the series that gets
 * plotted is the flat-equivalent speed — the speed that would cost the same
 * oxygen on level ground, by the same ACSM equation the rest of the app uses to
 * set treadmill targets.
 *
 * It is an estimate built on an estimate, and it says so on the panel.
 */

/** The level speed that costs the same oxygen as this speed at this gradient. */
export function gradeAdjustedSpeedKph(
  speedKph: number,
  inclinePct: number,
  economyPct = 100,
): number | null {
  if (!(speedKph > 0)) return null
  const { vo2 } = computeVo2(speedKph, inclinePct, economyPct)
  return solveSpeedForVo2(vo2, 0, economyPct)
}

export interface SpeedPoint {
  durationS: number
  kph: number
}

/**
 * Mean-maximal grade-adjusted speed. Samples with no speed count as standing
 * still rather than being skipped, so a curve over a step test includes the
 * sampling breaks for what they were.
 */
export function speedCurve(samples: readonly Sample[], economyPct = 100): SpeedPoint[] {
  const series = samples.map((sample) => {
    const speedKph = (sample.speedMs ?? 0) * 3.6
    if (!(speedKph > 0)) return 0
    return gradeAdjustedSpeedKph(speedKph, sample.inclinePct ?? 0, economyPct) ?? speedKph
  })
  return mmpCurve(series).map((point) => ({ durationS: point.durationS, kph: point.watts }))
}

/** The gradients drawn on the nomogram, in percent. */
export const NOMOGRAM_GRADES = [0, 2, 4, 6, 8, 10, 12, 15] as const

export interface NomogramCurve {
  inclinePct: number
  points: { speedKph: number; vo2: number }[]
}

/**
 * One line per gradient over a speed range: the field the live point is read
 * against. The relationship is linear in speed, so two points would draw it,
 * but the curve is sampled so that the same drawing code survives an equation
 * with curvature in it later.
 */
export function nomogramCurves(
  fromKph: number,
  toKph: number,
  economyPct = 100,
  grades: readonly number[] = NOMOGRAM_GRADES,
): NomogramCurve[] {
  const step = (toKph - fromKph) / 8
  return grades.map((inclinePct) => ({
    inclinePct,
    points: Array.from({ length: 9 }, (_, i) => {
      const speedKph = fromKph + step * i
      return { speedKph, vo2: computeVo2(speedKph, inclinePct, economyPct).vo2 }
    }),
  }))
}
