import { describe, expect, it } from 'vitest'
import type { Exhalation } from './breaths'
import { waterContentMgL } from './humidity'
import { waterTrend } from './waterTrend'

/** A breath ending at `s` seconds whose plateau carries `mgL` at 32 °C. */
const breath = (s: number, mgL: number): Exhalation => {
  const rhPct = (100 * mgL) / waterContentMgL(32, 100)
  return { startAt: s * 1000 - 1500, endAt: s * 1000, durationS: 1.5, volumeStdL: 1, pressurePa: 101_000, tempC: 32, rhPct, saturated: false }
}

describe('waterTrend', () => {
  it('fits the level and pace over the last minute and extrapolates to 90 % RH', () => {
    // Rising 3 mg/L per minute from 15: 18 at 60 s.
    const log = Array.from({ length: 13 }, (_, i) => breath(i * 5, 15 + (3 * i * 5) / 60))
    const trend = waterTrend(log, 60_000)!
    expect(trend.levelMgL).toBeCloseTo(18, 5)
    expect(trend.slopeMgLPerMin).toBeCloseTo(3, 5)
    const target = waterContentMgL(32, 90)
    expect(trend.targetMgL).toBeCloseTo(target, 5)
    expect(trend.toTargetS).toBeCloseTo(((target - 18) / 3) * 60, 3)
  })

  it('ignores breaths older than a minute', () => {
    const old = [breath(0, 5), breath(2, 5)]
    const recent = Array.from({ length: 10 }, (_, i) => breath(70 + i * 5, 20))
    expect(waterTrend([...old, ...recent], 120_000)!.breaths).toBe(10)
  })

  it('has no time to give when the reading is not rising, and zero once there', () => {
    const flat = Array.from({ length: 10 }, (_, i) => breath(i * 5, 20))
    expect(waterTrend(flat, 50_000)!.toTargetS).toBeNull()
    const wet = Array.from({ length: 10 }, (_, i) => breath(i * 5, 32))
    expect(waterTrend(wet, 50_000)!.toTargetS).toBe(0)
  })

  it('stays silent on too few breaths or too short a span', () => {
    expect(waterTrend([breath(1, 15), breath(5, 16), breath(9, 17)], 10_000)).toBeNull()
    const burst = Array.from({ length: 8 }, (_, i) => breath(50 + i, 15 + i))
    expect(waterTrend(burst, 60_000)).toBeNull()
  })
})
