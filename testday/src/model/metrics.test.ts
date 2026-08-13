import { describe, expect, it } from 'vitest'
import {
  MmpTracker,
  RollingAverage,
  formatClock,
  hrv,
  mmpCurve,
  normalizedPower,
  paceFromSpeed,
} from './metrics'

describe('RollingAverage', () => {
  it('averages only the trailing window', () => {
    const avg = new RollingAverage(3)
    avg.push(10)
    avg.push(20)
    expect(avg.isFull).toBe(false)
    expect(avg.push(30)).toBeCloseTo(20)
    expect(avg.isFull).toBe(true)
    expect(avg.push(60)).toBeCloseTo((20 + 30 + 60) / 3)
  })
})

describe('MmpTracker', () => {
  it('finds the best window anywhere in the series', () => {
    const tracker = new MmpTracker([1, 5, 10])
    const series = [100, 100, 500, 500, 500, 500, 500, 100, 100, 100]
    for (const p of series) tracker.push(p)
    expect(tracker.get(1)).toBe(500)
    expect(tracker.get(5)).toBe(500)
    expect(tracker.get(10)).toBeCloseTo(series.reduce((a, b) => a + b, 0) / 10)
  })

  it('omits durations longer than the recording', () => {
    const curve = mmpCurve([200, 200, 200], [1, 5, 60])
    expect(curve.map((p) => p.durationS)).toEqual([1])
  })

  it('matches a brute-force search on a noisy series', () => {
    const series = Array.from({ length: 400 }, (_, i) => 200 + Math.round(80 * Math.sin(i / 7)))
    const tracker = new MmpTracker([30])
    for (const p of series) tracker.push(p)

    let brute = -Infinity
    for (let i = 0; i + 30 <= series.length; i++) {
      const window = series.slice(i, i + 30).reduce((a, b) => a + b, 0) / 30
      if (window > brute) brute = window
    }
    expect(tracker.get(30)).toBeCloseTo(brute, 9)
  })
})

describe('normalizedPower', () => {
  it('is undefined for efforts shorter than the 30 s window', () => {
    expect(normalizedPower(new Array(20).fill(250))).toBeNull()
  })

  it('equals average power for a perfectly steady effort', () => {
    expect(normalizedPower(new Array(600).fill(250))).toBeCloseTo(250, 6)
  })

  it('exceeds average power for a variable effort', () => {
    const variable = Array.from({ length: 600 }, (_, i) => (Math.floor(i / 30) % 2 ? 400 : 100))
    const average = variable.reduce((a, b) => a + b, 0) / variable.length
    expect(normalizedPower(variable) as number).toBeGreaterThan(average)
  })
})

describe('formatting', () => {
  it('formats clocks with and without hours', () => {
    expect(formatClock(2)).toBe('0:02')
    expect(formatClock(95)).toBe('1:35')
    expect(formatClock(5818)).toBe('1:36:58')
  })

  it('formats running pace per kilometre', () => {
    expect(paceFromSpeed(1000 / 240)).toBe('4:00')
    expect(paceFromSpeed(0)).toBe('—')
  })
})

describe('hrv', () => {
  /** Every interval identical, so there is no variability to find. */
  it('is zero for a perfectly regular series', () => {
    const result = hrv(Array.from({ length: 30 }, () => 1000))
    expect(result?.rmssd).toBeCloseTo(0, 9)
    expect(result?.sdnn).toBeCloseTo(0, 9)
    expect(result?.meanHr).toBeCloseTo(60, 6)
  })

  it('computes rMSSD from successive differences', () => {
    // Alternating 900/1000 gives a difference of 100 ms at every step.
    const alternating = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 900 : 1000))
    expect(hrv(alternating)?.rmssd).toBeCloseTo(100, 6)
  })

  /**
   * Straps emit impossible intervals when they miss a beat, and a single one
   * of them would dominate rMSSD. They are dropped rather than clamped.
   */
  it('drops physiologically impossible intervals', () => {
    const clean = Array.from({ length: 30 }, () => 1000)
    const dirty = [...clean, 40, 5000]
    expect(hrv(dirty)?.beats).toBe(30)
    expect(hrv(dirty)?.rmssd).toBeCloseTo(0, 9)
  })

  it('refuses to answer on too few beats', () => {
    expect(hrv(Array.from({ length: 19 }, () => 1000))).toBeNull()
    expect(hrv([])).toBeNull()
  })
})
