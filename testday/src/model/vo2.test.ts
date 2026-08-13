import { describe, expect, it } from 'vitest'
import {
  RESTING_VO2,
  computeElevation,
  computeKcal,
  computeVo2,
  cyclingVo2,
  economyCategory,
  estimateVo2,
  pctOfVo2max,
  solveInclineForVo2,
  solveSpeedForVo2,
  speedToMPerMin,
} from './vo2'

describe('ACSM VO2', () => {
  it('reduces to resting VO2 at a standstill', () => {
    expect(computeVo2(0, 0).vo2).toBe(RESTING_VO2)
  })

  it('matches the ACSM equation worked by hand', () => {
    // 12 km/h = 200 m/min, level: 3.5 + 0.2 * 200 = 43.5
    expect(computeVo2(12, 0).vo2).toBeCloseTo(43.5, 6)
    expect(computeVo2(12, 0).mets).toBeCloseTo(43.5 / 3.5, 6)
  })

  it('adds the gradient term', () => {
    // 12 km/h at 2%: 3.5 + 0.2*200 + 0.9*200*0.02 = 43.5 + 3.6 = 47.1
    expect(computeVo2(12, 2).vo2).toBeCloseTo(47.1, 6)
  })

  it('scales the locomotion terms by economy but never the resting term', () => {
    const typical = computeVo2(12, 0).vo2
    const economical = computeVo2(12, 0, 90).vo2
    expect(economical).toBeCloseTo(RESTING_VO2 + (typical - RESTING_VO2) * 0.9, 6)
    // A more economical runner uses less oxygen for the same speed.
    expect(economical).toBeLessThan(typical)
  })

  it('treats a missing economy as typical', () => {
    expect(computeVo2(12, 1, 0).vo2).toBeCloseTo(computeVo2(12, 1, 100).vo2, 6)
  })

  it('converts km/h to metres per minute', () => {
    expect(speedToMPerMin(12)).toBeCloseTo(200, 6)
  })
})

describe('solving for a target', () => {
  it('round-trips speed through VO2 at several inclines', () => {
    for (const incline of [0, 1, 2.5, 6]) {
      for (const speed of [8, 12, 15.2, 20]) {
        const { vo2 } = computeVo2(speed, incline)
        expect(solveSpeedForVo2(vo2, incline)).toBeCloseTo(speed, 9)
      }
    }
  })

  it('round-trips speed through VO2 for a non-typical economy', () => {
    const { vo2 } = computeVo2(15, 1, 92)
    expect(solveSpeedForVo2(vo2, 1, 92)).toBeCloseTo(15, 9)
  })

  it('round-trips incline through VO2', () => {
    const { vo2 } = computeVo2(11, 4)
    expect(solveInclineForVo2(vo2, 11)).toBeCloseTo(4, 9)
  })

  it('refuses a target at or below rest rather than returning a negative speed', () => {
    expect(solveSpeedForVo2(RESTING_VO2, 0)).toBeNull()
    expect(solveSpeedForVo2(2, 0)).toBeNull()
    expect(solveInclineForVo2(RESTING_VO2, 12)).toBeNull()
  })

  it('refuses an incline solution that would have to be downhill', () => {
    // 12 km/h level already costs 43.5, so 40 cannot be reached by tilting up.
    expect(solveInclineForVo2(40, 12)).toBeNull()
  })

  it('refuses an incline solution at a standstill', () => {
    expect(solveInclineForVo2(50, 0)).toBeNull()
  })

  it('cannot solve a speed on a downhill that cancels the speed term', () => {
    // 0.2 + 0.9 * g = 0 at g = -2/9, i.e. -22.2%.
    expect(solveSpeedForVo2(50, -100 * (2 / 9))).toBeNull()
  })
})

describe('derived quantities', () => {
  it('computes energy at 5 kcal per litre of oxygen', () => {
    // 50 mL/kg/min * 70 kg = 3.5 L/min -> 17.5 kcal/min -> 175 kcal in 10 min.
    expect(computeKcal(50, 70, 10)).toBeCloseTo(175, 6)
  })

  it('computes elevation gain', () => {
    expect(computeElevation(5, 2)).toBeCloseTo(100, 6)
  })

  it('expresses VO2 as a share of a measured VO2max', () => {
    expect(pctOfVo2max(52, 65)).toBeCloseTo(80, 6)
    expect(pctOfVo2max(52, 0)).toBeNull()
  })

  it('labels economy bands at their boundaries', () => {
    expect(economyCategory(90)).toBe('veryEconomical')
    expect(economyCategory(99)).toBe('economical')
    expect(economyCategory(100)).toBe('typical')
    expect(economyCategory(110)).toBe('slightlyLess')
    expect(economyCategory(111)).toBe('clearlyLess')
  })
})

describe('cycling VO₂', () => {
  it('follows the ACSM leg-ergometry equation', () => {
    // 7 + 10.8 × 200 / 75 = 35.8
    expect(cyclingVo2(200, 75)?.vo2).toBeCloseTo(35.8, 4)
  })

  it('is the resting-plus-unloaded intercept at zero watts', () => {
    expect(cyclingVo2(0, 75)?.vo2).toBeCloseTo(7, 6)
  })

  it('refuses a mass it cannot divide by', () => {
    expect(cyclingVo2(200, 0)).toBeNull()
  })
})

describe('estimateVo2', () => {
  const athlete = { massKg: 75, economyPct: 100 }

  it('estimates a run from measured speed and gradient', () => {
    const estimate = estimateVo2('run', { speedKph: 12, inclinePct: 2 }, athlete)
    expect(estimate?.method).toBe('acsmRun')
    expect(estimate?.vo2).toBeCloseTo(computeVo2(12, 2).vo2, 6)
  })

  it('estimates a ride from power', () => {
    const estimate = estimateVo2('bike', { watts: 200 }, athlete)
    expect(estimate?.method).toBe('acsmBike')
    expect(estimate?.vo2).toBeCloseTo(35.8, 4)
  })

  /**
   * The whole point of the range flag: the number is still returned, because
   * refusing to display anything is its own kind of dishonesty, but it is
   * marked so the interface can stop presenting it as if it were measured.
   */
  it('flags a ride above the range the equation was fitted over', () => {
    expect(estimateVo2('bike', { watts: 150 }, athlete)?.inRange).toBe(true)
    const extrapolated = estimateVo2('bike', { watts: 400 }, athlete)
    expect(extrapolated?.inRange).toBe(false)
    expect(extrapolated?.vo2).toBeGreaterThan(0)
  })

  it('flags a walk as outside the running equation', () => {
    expect(estimateVo2('run', { speedKph: 5 }, athlete)?.inRange).toBe(false)
    expect(estimateVo2('run', { speedKph: 12 }, athlete)?.inRange).toBe(true)
  })

  /**
   * A missing sensor and a resting athlete must not look alike afterwards, so
   * the absent case is null rather than zero.
   */
  it('returns null when the driving metric is missing', () => {
    expect(estimateVo2('bike', {}, athlete)).toBeNull()
    expect(estimateVo2('run', {}, athlete)).toBeNull()
    expect(estimateVo2('run', { speedKph: 0 }, athlete)).toBeNull()
  })

  it('assumes level ground when no gradient is known', () => {
    const level = estimateVo2('run', { speedKph: 12 }, athlete)
    expect(level?.vo2).toBeCloseTo(computeVo2(12, 0).vo2, 6)
  })
})
