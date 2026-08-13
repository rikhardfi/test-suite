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
  decoupling,
  wPrimeBalance,
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

describe('wPrimeBalance', () => {
  it('starts full and stays full below critical power', () => {
    const balance = wPrimeBalance([200, 200, 200], 250, 20000)
    expect(balance.every((b) => b === 20000)).toBe(true)
  })

  it('spends W′ at the rate the athlete exceeds CP', () => {
    // 50 W over CP for 10 s is 500 J out of the tank.
    const balance = wPrimeBalance(Array(10).fill(300), 250, 20000)
    expect(balance[balance.length - 1]).toBeCloseTo(19500, 6)
  })

  it('refills more slowly as the tank fills', () => {
    const spent = wPrimeBalance(Array(60).fill(350), 250, 20000)
    const start = spent[spent.length - 1]
    const recovering = wPrimeBalance(
      [...Array(60).fill(350), ...Array(120).fill(150)],
      250,
      20000,
    )
    // Index 59 is the last of the 60 hard seconds, so the two series agree
    // there and diverge from index 60 on.
    const early = recovering[65] - recovering[60]
    const late = recovering[175] - recovering[170]
    expect(recovering[59]).toBeCloseTo(start, 6)
    expect(early).toBeGreaterThan(late)
  })

  it('never goes negative or above the tank', () => {
    const balance = wPrimeBalance(Array(600).fill(600), 250, 20000)
    expect(Math.min(...balance)).toBe(0)
    expect(Math.max(...balance)).toBeLessThanOrEqual(20000)
  })

  /** Without a valid fit there is no model, and a plausible number would be worse than none. */
  it('returns nothing without a usable CP and W′', () => {
    expect(wPrimeBalance([200], 0, 20000)).toEqual([])
    expect(wPrimeBalance([200], 250, 0)).toEqual([])
  })
})

describe('decoupling', () => {
  it('is zero when output per heartbeat holds steady', () => {
    const power = Array(240).fill(200)
    const hr = Array(240).fill(150)
    expect(decoupling(power, hr)?.pctDrift).toBeCloseTo(0, 6)
  })

  it('is positive when heart rate drifts up at the same output', () => {
    const power = Array(240).fill(200)
    const hr = [...Array(120).fill(150), ...Array(120).fill(160)]
    const result = decoupling(power, hr)
    // Same watts against a higher heart rate is a fall in the ratio.
    expect(result!.pctDrift).toBeLessThan(0)
    expect(result!.pctDrift).toBeCloseTo((150 / 160 - 1) * 100, 1)
  })

  /**
   * A short stage produces a number that is entirely noise, so it produces no
   * number at all instead.
   */
  it('refuses a block too short to mean anything', () => {
    expect(decoupling(Array(100).fill(200), Array(100).fill(150))).toBeNull()
    expect(decoupling([], [])).toBeNull()
  })

  it('ignores samples with no heart rate rather than treating them as zero', () => {
    const power = Array(240).fill(200)
    const hr = Array(240).fill(150)
    hr[5] = 0
    expect(decoupling(power, hr)?.pctDrift).toBeCloseTo(0, 6)
  })
})
