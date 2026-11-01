import type { Exhalation } from './breaths'
import { waterContentMgL } from './humidity'

/**
 * Exhaled water content and where it is heading, live.
 *
 * The TSI's humidity sensor takes minutes to settle (on 2026-11-01 its
 * exhaled reading was still climbing at the end of every 3 min bout), so the
 * level alone says little. This fits a straight line to the late-plateau water
 * content of each exhalation over the last minute and extrapolates it, at that
 * pace, to 90 % RH at the exhaled gas temperature: how long the bout would have
 * to last for the meter to read nearly saturated air, if the air is saturated.
 *
 * A straight line overstates the pace of a first-order approach that is
 * slowing down, so the predicted time is a lower bound. Pure.
 */

export const WATER_TREND = {
  windowS: 60,
  /** Fewer breaths, or a shorter span, and the slope is noise. */
  minBreaths: 5,
  minSpanS: 20,
  targetRhPct: 90,
} as const

export interface WaterTrend {
  /** Fitted level at the newest breath, mg/L (= g/m³), at the gas's own temperature. */
  levelMgL: number
  /** mg/L per minute. */
  slopeMgLPerMin: number
  /** 90 % RH at the mean plateau temperature of the window, mg/L. */
  targetMgL: number
  /** Mean plateau temperature over the window, °C. */
  tempC: number
  /** Seconds to the target at the current pace: 0 when there, null when not rising. */
  toTargetS: number | null
  breaths: number
}

export function waterTrend(log: readonly Exhalation[], now: number, settings = WATER_TREND): WaterTrend | null {
  const from = now - settings.windowS * 1000
  const window = log.filter((b) => b.endAt > from && b.endAt <= now)
  if (window.length < settings.minBreaths) return null
  const t = window.map((b) => b.endAt / 1000)
  const w = window.map((b) => waterContentMgL(b.tempC, Math.min(b.rhPct, 100)))
  if (t[t.length - 1] - t[0] < settings.minSpanS) return null

  const n = t.length
  const tMean = t.reduce((a, b) => a + b, 0) / n
  const wMean = w.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (t[i] - tMean) * (w[i] - wMean)
    sxx += (t[i] - tMean) ** 2
  }
  const slopePerS = sxy / sxx
  const levelMgL = wMean + slopePerS * (t[n - 1] - tMean)
  const tempC = window.reduce((a, b) => a + b.tempC, 0) / n
  const targetMgL = waterContentMgL(tempC, settings.targetRhPct)

  const toTargetS = levelMgL >= targetMgL ? 0 : slopePerS > 0 ? (targetMgL - levelMgL) / slopePerS : null
  return { levelMgL, slopeMgLPerMin: slopePerS * 60, targetMgL, tempC, toTargetS, breaths: n }
}
