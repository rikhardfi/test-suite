import { describe, expect, it } from 'vitest'
import { gradeAdjustedSpeedKph, nomogramCurves, speedCurve } from './running'
import { computeVo2 } from './vo2'
import type { Sample } from './session'

const sample = (t: number, speedMs: number, inclinePct = 0): Sample => ({
  t,
  stepIndex: 0,
  phase: 'work',
  speedMs,
  inclinePct,
})

describe('gradeAdjustedSpeedKph', () => {
  it('leaves a level run alone', () => {
    expect(gradeAdjustedSpeedKph(12, 0)).toBeCloseTo(12, 6)
  })

  it('makes an uphill worth more than the speed on the display', () => {
    const adjusted = gradeAdjustedSpeedKph(10, 12)!
    expect(adjusted).toBeGreaterThan(10)
    // The flat-equivalent must cost the same oxygen as what was actually run.
    expect(computeVo2(adjusted, 0).vo2).toBeCloseTo(computeVo2(10, 12).vo2, 6)
  })

  it('carries the athlete’s economy through', () => {
    // A more economical runner covers the same oxygen cost at a higher speed,
    // but the *equivalence* is between two speeds for the same runner, so the
    // adjustment itself does not move.
    expect(gradeAdjustedSpeedKph(10, 10, 92)).toBeCloseTo(gradeAdjustedSpeedKph(10, 10, 100)!, 6)
  })

  it('has nothing to say about standing still', () => {
    expect(gradeAdjustedSpeedKph(0, 5)).toBeNull()
  })
})

describe('speedCurve', () => {
  it('reports the best sustained flat-equivalent speed by duration', () => {
    const samples = Array.from({ length: 120 }, (_, t) => sample(t, 3))
    const curve = speedCurve(samples)
    const sixty = curve.find((p) => p.durationS === 60)!
    expect(sixty.kph).toBeCloseTo(10.8, 1)
  })

  it('rates a climb above a faster level run of the same oxygen cost', () => {
    const climb = Array.from({ length: 120 }, (_, t) => sample(t, 2.5, 10))
    const level = Array.from({ length: 120 }, (_, t) => sample(t, 2.5, 0))
    const at = (samples: Sample[]) => speedCurve(samples).find((p) => p.durationS === 60)!.kph
    expect(at(climb)).toBeGreaterThan(at(level))
  })

  it('counts a standing break as standing, not as a gap in the data', () => {
    const samples = [
      ...Array.from({ length: 60 }, (_, t) => sample(t, 4)),
      ...Array.from({ length: 60 }, (_, t) => sample(60 + t, 0)),
    ]
    const curve = speedCurve(samples)
    const sixty = curve.find((p) => p.durationS === 60)!.kph
    const oneTwenty = curve.find((p) => p.durationS === 120)!.kph
    expect(oneTwenty).toBeLessThan(sixty / 1.5)
  })
})

describe('nomogramCurves', () => {
  it('draws one line per gradient across the speed range', () => {
    const curves = nomogramCurves(6, 18)
    expect(curves).toHaveLength(8)
    expect(curves[0].inclinePct).toBe(0)
    expect(curves[0].points[0].speedKph).toBeCloseTo(6, 6)
    expect(curves[0].points.at(-1)!.speedKph).toBeCloseTo(18, 6)
  })

  it('puts a steeper gradient above a shallower one at the same speed', () => {
    const [level, two] = nomogramCurves(6, 18)
    expect(two.points[4].vo2).toBeGreaterThan(level.points[4].vo2)
  })

  it('agrees with the equation the treadmill targets are set from', () => {
    const [level] = nomogramCurves(6, 18)
    for (const point of level.points) {
      expect(point.vo2).toBeCloseTo(computeVo2(point.speedKph, 0).vo2, 9)
    }
  })
})
