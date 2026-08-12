import { describe, expect, it } from 'vitest'
import { MmpTracker, RollingAverage, formatClock, mmpCurve, normalizedPower, paceFromSpeed } from './metrics'

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
