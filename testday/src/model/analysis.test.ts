import { describe, expect, it } from 'vitest'
import {
  analyseLactate,
  baselinePlus,
  criticalPower,
  dmax,
  intensityAtLactate,
  linearFit,
  logLogLt1,
  obla,
  polyfit,
  polyval,
  type LactatePoint,
} from './analysis'

/** A realistic submaximal step test: flat, then a knee, then a steep rise. */
const stepTest: LactatePoint[] = [
  { intensity: 150, lactate: 0.9, heartRate: 108 },
  { intensity: 175, lactate: 1.0, heartRate: 120 },
  { intensity: 200, lactate: 1.2, heartRate: 131 },
  { intensity: 225, lactate: 1.6, heartRate: 142 },
  { intensity: 250, lactate: 2.3, heartRate: 152 },
  { intensity: 275, lactate: 3.4, heartRate: 162 },
  { intensity: 300, lactate: 5.2, heartRate: 172 },
  { intensity: 325, lactate: 7.8, heartRate: 180 },
]

describe('polyfit', () => {
  it('recovers the coefficients of an exact cubic', () => {
    const truth = [2, -1, 0.5, 0.25]
    const x = [-3, -2, -1, 0, 1, 2, 3, 4]
    const y = x.map((v) => polyval(truth, v))
    const fitted = polyfit(x, y, 3)
    fitted.forEach((c, i) => expect(c).toBeCloseTo(truth[i], 6))
  })

  it('refuses to fit with too few points', () => {
    expect(() => polyfit([1, 2, 3], [1, 2, 3], 3)).toThrow(/at least 4 points/)
  })
})

describe('linearFit', () => {
  it('fits a perfect line with r2 of 1', () => {
    const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7])
    expect(fit.slope).toBeCloseTo(2, 9)
    expect(fit.intercept).toBeCloseTo(1, 9)
    expect(fit.r2).toBeCloseTo(1, 9)
  })
})

describe('intensityAtLactate', () => {
  it('lands between the bracketing stages', () => {
    const at4 = intensityAtLactate(stepTest, 4)
    expect(at4).not.toBeNull()
    expect(at4 as number).toBeGreaterThan(275)
    expect(at4 as number).toBeLessThan(300)
  })

  it('returns null when the test never reaches the concentration', () => {
    expect(intensityAtLactate(stepTest, 12)).toBeNull()
  })
})

describe('threshold methods', () => {
  it('OBLA 4 sits above OBLA 2', () => {
    const two = obla(stepTest, 2)
    const four = obla(stepTest, 4)
    expect(two.intensity).not.toBeNull()
    expect(four.intensity as number).toBeGreaterThan(two.intensity as number)
  })

  it('interpolates heart rate at the threshold intensity', () => {
    const result = obla(stepTest, 4)
    expect(result.heartRate).toBeGreaterThan(162)
    expect(result.heartRate).toBeLessThan(172)
  })

  it('places Dmax inside the tested range', () => {
    const result = dmax(stepTest)
    expect(result.intensity).not.toBeNull()
    expect(result.intensity as number).toBeGreaterThan(150)
    expect(result.intensity as number).toBeLessThan(325)
  })

  it('modified Dmax reports at or above plain Dmax', () => {
    const plain = dmax(stepTest, false)
    const modified = dmax(stepTest, true)
    expect(modified.intensity).not.toBeNull()
    expect(modified.intensity as number).toBeGreaterThanOrEqual((plain.intensity as number) - 1)
  })

  it('baseline + 1.0 falls below OBLA 4', () => {
    const lt1 = baselinePlus(stepTest, 1.0)
    const lt2 = obla(stepTest, 4)
    expect(lt1.intensity as number).toBeLessThan(lt2.intensity as number)
  })

  it('log-log picks a breakpoint on a measured stage', () => {
    const result = logLogLt1(stepTest)
    expect(result.intensity).not.toBeNull()
    expect(stepTest.map((p) => p.intensity)).toContain(result.intensity)
  })

  it('reports every method without throwing on a short test', () => {
    const short = stepTest.slice(0, 3)
    const results = analyseLactate(short)
    expect(results).toHaveLength(6)
    expect(results.every((r) => 'label' in r)).toBe(true)
  })
})

describe('criticalPower', () => {
  it('recovers CP and W-prime from a synthetic hyperbolic curve', () => {
    const cp = 300
    const wPrime = 20000
    const curve = [120, 180, 300, 480, 600, 900, 1200].map((durationS) => ({
      durationS,
      watts: cp + wPrime / durationS,
    }))
    const result = criticalPower(curve)
    expect(result).not.toBeNull()
    expect((result as NonNullable<typeof result>).cpWatts).toBeCloseTo(cp, 6)
    expect((result as NonNullable<typeof result>).wPrimeJoules).toBeCloseTo(wPrime, 3)
  })

  it('returns null when too few efforts fall in the fitting window', () => {
    expect(criticalPower([{ durationS: 300, watts: 320 }])).toBeNull()
  })
})
