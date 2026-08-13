/**
 * ACSM treadmill VO₂ estimation.
 *
 * Ported from `rikhardfi/treadmill-vo2-calculator` (`src/model.js`), so a run
 * protocol built here and a target worked out in that calculator agree to the
 * digit. The equation is the ACSM running metabolic equation:
 *
 *   VO₂ (mL/kg/min) = 3.5 + (0.2 × S + 0.9 × S × G) × economy
 *
 * where S is speed in metres per minute and G is the grade as a fraction.
 * The economy factor scales the locomotion terms only, never the 3.5 mL/kg/min
 * resting term, which is how the source calculator does it.
 *
 * What the equation is and is not: it is a population regression for treadmill
 * running above roughly 8 km/h, not a measurement. It does not know this
 * athlete's economy unless you tell it, and it says nothing about whether the
 * athlete can hold the resulting speed. Treat a solved speed as a starting
 * prescription to be checked against what the athlete actually does.
 *
 * Everything here is pure.
 */

/** Resting metabolic rate assumed by the ACSM equations, mL/kg/min. */
export const RESTING_VO2 = 3.5

/** One litre of oxygen consumed is taken as 5 kcal. */
const KCAL_PER_LITRE_O2 = 5

export const speedToMPerMin = (speedKph: number): number => (speedKph * 1000) / 60

export const mPerMinToSpeed = (mPerMin: number): number => (mPerMin * 60) / 1000

export const gradeFraction = (inclinePct: number): number =>
  (Number.isFinite(inclinePct) ? inclinePct : 0) / 100

export interface Vo2Result {
  /** mL/kg/min. */
  vo2: number
  mets: number
}

/**
 * VO₂ for a treadmill speed and incline.
 * `economyPct` is 100 for a typical runner; lower is more economical.
 */
export function computeVo2(speedKph: number, inclinePct: number, economyPct = 100): Vo2Result {
  const economy = (economyPct || 100) / 100
  const sm = speedToMPerMin(speedKph)
  const g = gradeFraction(inclinePct)
  const vo2 = RESTING_VO2 + (0.2 * sm + 0.9 * sm * g) * economy
  return { vo2, mets: vo2 / RESTING_VO2 }
}

/**
 * Speed in km/h that produces a target VO₂ at a fixed incline. Null when no
 * positive speed satisfies it, which happens for a target at or below rest.
 */
export function solveSpeedForVo2(
  targetVo2: number,
  inclinePct: number,
  economyPct = 100,
): number | null {
  const economy = (economyPct || 100) / 100
  if (targetVo2 <= RESTING_VO2) return null
  const g = gradeFraction(inclinePct)
  const perMPerMin = (0.2 + 0.9 * g) * economy
  // The equation is singular at g = -2/9 (a 22% descent), where speed stops
  // costing anything. The source calculator tests `<= 0`, which lets a gradient
  // a floating-point hair away from the singularity through and returns a speed
  // of order 1e17. This tool commands a treadmill, so the degenerate case is
  // rejected outright rather than allowed to produce a number.
  if (!(perMPerMin > 1e-9)) return null
  const sm = (targetVo2 - RESTING_VO2) / perMPerMin
  if (!(sm > 0) || !Number.isFinite(sm)) return null
  return mPerMinToSpeed(sm)
}

/** Incline in percent that produces a target VO₂ at a fixed speed. */
export function solveInclineForVo2(
  targetVo2: number,
  speedKph: number,
  economyPct = 100,
): number | null {
  const economy = (economyPct || 100) / 100
  if (targetVo2 <= RESTING_VO2) return null
  const sm = speedToMPerMin(speedKph)
  const numerator = (targetVo2 - RESTING_VO2) / economy - 0.2 * sm
  const denominator = 0.9 * sm
  if (denominator <= 0) return null
  const pct = (numerator / denominator) * 100
  if (!Number.isFinite(pct) || pct < 0) return null
  return pct
}

/** Energy cost of an interval, in kcal. */
export const computeKcal = (vo2: number, bodyMassKg: number, durationMin: number): number =>
  ((vo2 * bodyMassKg) / 1000) * KCAL_PER_LITRE_O2 * durationMin

/** Vertical metres climbed over a distance at a fixed gradient. */
export const computeElevation = (distanceKm: number, inclinePct: number): number =>
  distanceKm * 1000 * (inclinePct / 100)

export type EconomyCategory =
  | 'veryEconomical'
  | 'economical'
  | 'typical'
  | 'slightlyLess'
  | 'clearlyLess'

export function economyCategory(economyPct: number): EconomyCategory {
  if (economyPct <= 90) return 'veryEconomical'
  if (economyPct <= 99) return 'economical'
  if (economyPct === 100) return 'typical'
  if (economyPct <= 110) return 'slightlyLess'
  return 'clearlyLess'
}

export const ECONOMY_LABELS: Record<EconomyCategory, string> = {
  veryEconomical: 'very economical',
  economical: 'economical',
  typical: 'typical',
  slightlyLess: 'slightly less economical',
  clearlyLess: 'clearly less economical',
}

/** VO₂ as a percentage of a known VO₂max, when one has been measured. */
export const pctOfVo2max = (vo2: number, vo2max: number): number | null =>
  vo2max > 0 ? (vo2 / vo2max) * 100 : null
