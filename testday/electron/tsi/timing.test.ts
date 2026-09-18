import { describe, expect, it } from 'vitest'
import { SegmentClock, gapSamples, gapVolumeL } from './timing'

describe('SegmentClock', () => {
  it('recovers sample times from bursty, late arrivals', () => {
    // True row times: 1000 + i·10. Rows are held and released every 40 ms,
    // plus a fixed 0.8 ms transport time, so most arrive tens of ms late.
    const dt = 10
    const clock = new SegmentClock(dt)
    const truth: number[] = []
    for (let i = 0; i < 3000; i++) {
      const t = 1000 + i * dt
      truth.push(t)
      const released = Math.ceil(t / 40) * 40 + 0.8
      expect(clock.add(released)).toBe(i)
    }
    for (const i of [0, 1, 1234, 2999]) {
      expect(Math.abs(clock.timeOf(i) - truth[i])).toBeLessThan(1)
    }
    expect(clock.endMs).toBeCloseTo(clock.anchorMs + 2999 * dt)
    expect(clock.observedDtMs).toBeCloseTo(dt, 1)
  })

  it('never places a row later than it arrived', () => {
    const clock = new SegmentClock(1)
    const arrivals = [105, 105, 105, 108, 108, 109, 115]
    arrivals.forEach((a) => clock.add(a))
    arrivals.forEach((a, i) => expect(clock.timeOf(i)).toBeLessThanOrEqual(a))
  })
})

describe('gapSamples', () => {
  it('counts nothing missing between adjacent rows', () => {
    expect(gapSamples(1000, 1010, 10)).toBe(0)
  })

  it('counts the rows that would have fitted in a restart pause', () => {
    // Last row at 1000, next at 1090: rows at 1010…1080 are missing.
    expect(gapSamples(1000, 1090, 10)).toBe(8)
  })
})

describe('gapVolumeL', () => {
  it('takes the volume of the gap from the totalizer', () => {
    // 60 L/min for a 100 ms gap is 0.1 L; the first row's own 10 ms is excluded.
    expect(gapVolumeL(5, 5.11, 60, 10, false)).toBeCloseTo(0.1)
  })

  it('refuses when the totalizer was reset in between', () => {
    expect(gapVolumeL(5, 0.01, 60, 10, true)).toBeNull()
  })
})
