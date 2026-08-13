import { describe, expect, it } from 'vitest'
import { parseCartCsv, twoSegmentBreakpoint, ventilatoryThresholds } from './ventilatory'
import { analyseLactateWithBands } from './analysis'
import type { LactatePoint } from './analysis'
import { judgeTrend, type TrendPoint } from './longitudinal'

describe('reading a cart export', () => {
  it('matches columns whatever the cart called them', () => {
    const csv = [
      'Time,V\'O2 (mL/min),VCO2 [mL/min],VE BTPS,HR',
      '0:00,900,780,22.4,102',
      '0:05,1200,1010,26.1,110',
    ].join('\n')

    const result = parseCartCsv(csv)
    expect(result.samples).toHaveLength(2)
    expect(result.samples[1]).toMatchObject({ t: 5, vo2: 1200, vco2: 1010, ve: 26.1, heartRate: 110 })
    expect(result.matched.vo2).toBe("V'O2 (mL/min)")
  })

  it('reads a semicolon-delimited file with decimal commas', () => {
    const csv = ['t;VO2;VCO2;VE', '0;900;780;22,4', '5;1200;1010;26,1'].join('\n')
    const result = parseCartCsv(csv)
    expect(result.samples[1].ve).toBeCloseTo(26.1, 4)
  })

  it('reads mm:ss and hh:mm:ss timestamps', () => {
    const csv = ['Time,VO2', '12:30,2400', '1:02:03,2500'].join('\n')
    const result = parseCartCsv(csv)
    expect(result.samples[0].t).toBe(750)
    expect(result.samples[1].t).toBe(3723)
  })

  /**
   * A silent import that quietly found no VCO₂ column produces a file with no
   * VT1 and no explanation, and the operator is left guessing whether the
   * threshold is absent or the import is.
   */
  it('reports which columns it understood and which it skipped', () => {
    const csv = ['Time,VO2,Weird Column', '0,900,1'].join('\n')
    const result = parseCartCsv(csv)
    expect(result.matched.vo2).toBe('VO2')
    expect(result.matched.vco2).toBeUndefined()
    expect(result.ignored).toContain('Weird Column')
  })

  it('returns nothing for a file that is not a table', () => {
    expect(parseCartCsv('').samples).toEqual([])
    expect(parseCartCsv('just a header row').samples).toEqual([])
  })
})

describe('twoSegmentBreakpoint', () => {
  it('finds the join in a clean hinge', () => {
    // Slope 1 up to x = 50, then slope 2.
    const x = Array.from({ length: 100 }, (_, i) => i)
    const y = x.map((v) => (v <= 50 ? v : 50 + (v - 50) * 2))
    const found = twoSegmentBreakpoint(x, y)
    expect(found!.index).toBeGreaterThan(45)
    expect(found!.index).toBeLessThan(56)
    expect(found!.slopeBefore).toBeCloseTo(1, 1)
    expect(found!.slopeAfter).toBeCloseTo(2, 1)
  })

  it('refuses a series too short to have two segments', () => {
    expect(twoSegmentBreakpoint([1, 2, 3], [1, 2, 3])).toBeNull()
  })
})

/** A synthetic incremental test with a genuine V-slope hinge and a VE rise. */
function syntheticTest() {
  const samples = []
  for (let i = 0; i < 200; i++) {
    const t = i * 3
    const vo2 = 800 + i * 20
    // Below the hinge CO2 tracks oxygen; above it, buffering adds more.
    const vco2 = i < 100 ? 0.85 * vo2 : 0.85 * (800 + 100 * 20) + 1.35 * (vo2 - (800 + 100 * 20))
    // VE/VCO2 falls, flattens, then climbs from the compensation point.
    const equivalent = i < 60 ? 34 - i * 0.1 : i < 140 ? 28 : 28 + (i - 140) * 0.25
    samples.push({ t, vo2, vco2, ve: (equivalent * vco2) / 1000, heartRate: 100 + i * 0.4 })
  }
  return samples
}

describe('ventilatoryThresholds', () => {
  it('finds VT1 at the V-slope hinge and VT2 at the VE/VCO₂ rise', () => {
    const result = ventilatoryThresholds(syntheticTest())
    expect(result.vt1).not.toBeNull()
    expect(result.vt2).not.toBeNull()
    // The hinge is at index 100, which is t = 300 s and VO2 = 2800.
    expect(result.vt1!.vo2).toBeGreaterThan(2400)
    expect(result.vt1!.vo2).toBeLessThan(3200)
    // Compensation starts at index 140, so VT2 must come after VT1.
    expect(result.vt2!.t).toBeGreaterThan(result.vt1!.t)
    expect(result.problems).toEqual([])
  })

  it('carries the method and the slopes, so the number can be argued with', () => {
    const result = ventilatoryThresholds(syntheticTest())
    expect(result.vt1!.method).toContain('V-slope')
    expect(result.vt1!.note).toMatch(/Slope .* below/)
    expect(result.vt2!.method).toContain('VE/VCO₂')
  })

  /**
   * The breakpoint search always returns its best split, including on noise.
   * A split where the slope falls is the best fit to nothing, and reporting it
   * as VT1 would be worse than reporting nothing.
   */
  it('refuses a breakpoint whose slope goes the wrong way', () => {
    const flat = Array.from({ length: 120 }, (_, i) => ({
      t: i,
      vo2: 1000 + i * 10,
      vco2: 900 + i * 12 - i * i * 0.05,
      ve: 30,
    }))
    const result = ventilatoryThresholds(flat)
    expect(result.vt1).toBeNull()
    expect(result.problems.join(' ')).toContain('not a ventilatory threshold')
  })

  it('says plainly when the columns needed are missing', () => {
    const noVe = syntheticTest().map(({ ve: _ve, ...rest }) => rest)
    const result = ventilatoryThresholds(noVe)
    expect(result.vt1).not.toBeNull()
    expect(result.vt2).toBeNull()
    expect(result.problems.join(' ')).toContain('No VE column')
  })

  it('refuses to work on a handful of breaths', () => {
    const result = ventilatoryThresholds([{ t: 0, vo2: 900, vco2: 800 }])
    expect(result.problems[0]).toContain('at least 30')
  })
})

describe('threshold uncertainty', () => {
  const stable: LactatePoint[] = [
    { intensity: 150, lactate: 0.9, heartRate: 108 },
    { intensity: 180, lactate: 1.1, heartRate: 122 },
    { intensity: 210, lactate: 1.5, heartRate: 138 },
    { intensity: 240, lactate: 2.3, heartRate: 152 },
    { intensity: 270, lactate: 3.9, heartRate: 166 },
    { intensity: 300, lactate: 6.4, heartRate: 178 },
  ]

  it('puts a band on every method that produced an estimate', () => {
    const bands = analyseLactateWithBands(stable)
    const withEstimates = bands.filter((b) => b.intensity != null)
    expect(withEstimates.length).toBeGreaterThan(0)
    for (const band of withEstimates) {
      expect(band.fits).toBeGreaterThan(0)
      expect(band.lowIntensity).not.toBeNull()
      expect(band.lowIntensity!).toBeLessThanOrEqual(band.highIntensity!)
    }
  })

  /**
   * The point of the band: if removing one blood sample moves the threshold a
   * long way, that is what the estimate is worth, and the interface has to say
   * so rather than print the decimals.
   */
  it('marks a method unstable when dropping one point moves it a long way', () => {
    const noisy: LactatePoint[] = [
      { intensity: 150, lactate: 1.2 },
      { intensity: 180, lactate: 0.8 },
      { intensity: 210, lactate: 3.4 },
      { intensity: 240, lactate: 1.6 },
      { intensity: 270, lactate: 5.9 },
      { intensity: 300, lactate: 3.1 },
    ]
    const bands = analyseLactateWithBands(noisy)
    const unstable = bands.filter((b) => b.intensity != null && b.unstable)
    expect(unstable.length).toBeGreaterThan(0)
    expect(unstable[0].reason).toBeTruthy()
  })

  /** Too few points to drop one is itself a statement about the estimate. */
  it('says so when there are too few points to band at all', () => {
    const bands = analyseLactateWithBands(stable.slice(0, 3))
    const reported = bands.filter((b) => b.intensity != null)
    for (const band of reported) {
      expect(band.unstable).toBe(true)
      expect(band.reason).toContain('too few')
    }
  })
})

describe('judging a trend across test days', () => {
  const point = (startedAt: number, intensity: number, spread: number): TrendPoint => ({
    startedAt,
    sessionId: `s${startedAt}`,
    intensity,
    low: intensity - spread,
    high: intensity + spread,
    unstable: false,
  })

  /**
   * The whole reason the bands are carried through: a trend drawn through six
   * point estimates looks like a trend whether or not the estimates could
   * support one.
   */
  it('refuses to call a change that its own uncertainty covers', () => {
    const verdict = judgeTrend([point(1, 250, 20), point(2, 262, 20)])
    expect(verdict?.changed).toBe(false)
    expect(verdict?.summary).toContain('cannot tell')
    // The percentage is still reported, because hiding it would be its own
    // kind of dishonesty. It is the verdict that is withheld.
    expect(verdict?.deltaPct).toBeCloseTo(4.8, 1)
  })

  it('calls a change that clears both ranges', () => {
    const verdict = judgeTrend([point(1, 250, 5), point(2, 290, 5)])
    expect(verdict?.changed).toBe(true)
    expect(verdict?.summary).toContain("athlete's own earlier test")
  })

  it('says nothing from a single test', () => {
    expect(judgeTrend([point(1, 250, 5)])).toBeNull()
    expect(judgeTrend([])).toBeNull()
  })
})
