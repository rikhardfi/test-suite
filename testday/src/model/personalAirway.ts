import { btpsFactor, minutesAbove, type Room } from './airway'
import type { Exhalation } from './breaths'
import { fig2Curve, personalThreshold, type Fig2Curve, type PersonalThreshold, type Sex } from './karamaoun'
import { frcOf, veFromHr, type HrVeCurve, type LungProfile } from './lungProfile'
import type { Sample } from './session'

/**
 * Everything the live airway panel and the Karamaoun tile draw from, for one
 * tick: the athlete's FRC, their threshold in this room, the Fig 2 curve at
 * the current VE (TSI, primary) and at the VE their heart rate predicts, and
 * minutes above the threshold by each.
 *
 * Null without an imported spirometry (RMH 2026-10-31: no FRC, no curve) or
 * without room air. The TSI and HR halves are null independently.
 *
 * The thresholds and curves cost a few Haut solves each, so they are cached on
 * values rounded to what the display resolves (0.1 °C, 1 % RH, 1 L/min).
 */
export interface PersonalAirway {
  frcL: number
  frcSource: string
  room: Room
  threshold: PersonalThreshold
  /** heldS: seconds since the last exhalation, when this is the last bout's value held over. */
  tsi: { veLMin: number; curve: Fig2Curve; minutesAbove: [number, number] | null; heldS?: number } | null
  hr: { veLMin: number; curve: Fig2Curve; label: string; minutesAbove: [number, number] } | null
  /** The curves at the two upper-edge thresholds, for faint reference lines. */
  references: { label: string; veLMin: number; curve: number[] }[]
}

export interface PersonalAirwayInput {
  lungs?: LungProfile
  hrVeCurve?: HrVeCurve
  room: Room | null
  pressurePa?: number
  /** Last 30 s TSI VE at BTPS, when the meter is breathing. */
  tsiVeLMin: number | null
  heartRate: number | null
  /** For TSI minutes above. */
  exhalations?: readonly Exhalation[]
  tsiNow?: number
  /** Test start, ms. */
  since?: number
  samples: readonly Sample[]
  on?: Date
}

const cache = new Map<string, unknown>()
function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) {
    if (cache.size > 400) cache.clear()
    cache.set(key, make())
  }
  return cache.get(key) as T
}

export function personalAirway(input: PersonalAirwayInput): PersonalAirway | null {
  const frc = frcOf(input.lungs, input.on)
  if (!frc || !input.room || !input.lungs) return null
  const sex: Sex = input.lungs.sex
  const t = Math.round(input.room.tempC * 10) / 10
  const rh = Math.round(input.room.humidityPct)
  const p = Math.round((input.pressurePa ?? 101325) / 100) * 100
  const f = Math.round(frc.frcL * 100) / 100
  const threshold = cached(`thr|${f}|${t}|${rh}|${p}|${sex}`, () => personalThreshold(f, t, rh, p, sex))
  const curveAt = (ve: number) => {
    const v = Math.round(ve)
    return cached(`c|${f}|${t}|${rh}|${sex}|${v}`, () => fig2Curve(f, v, t, rh, sex))
  }
  const upper = [threshold.hautShifted[1], threshold.waterDeficit[1]] as const

  const references = [
    { label: 'Haut-shifted threshold', veLMin: upper[0] },
    { label: 'water-deficit threshold', veLMin: upper[1] },
  ]
    .filter((r) => Number.isFinite(r.veLMin))
    .map((r) => ({ ...r, curve: curveAt(r.veLMin).karamaoun }))

  let tsi: PersonalAirway['tsi'] = null
  if (input.tsiVeLMin != null && Number.isFinite(input.tsiVeLMin) && input.tsiVeLMin > 0) {
    const log = input.exhalations
    const canCount = !!log?.length && input.since != null && input.tsiNow != null
    const btps = btpsFactor(input.pressurePa ?? 101325)
    tsi = {
      veLMin: input.tsiVeLMin,
      curve: curveAt(input.tsiVeLMin),
      minutesAbove: canCount
        ? [
            minutesAbove(log!, upper[0], btps, input.since!, input.tsiNow!),
            minutesAbove(log!, upper[1], btps, input.since!, input.tsiNow!),
          ]
        : null,
    }
  }

  let hr: PersonalAirway['hr'] = null
  const veHr = veFromHr(input.hrVeCurve, input.heartRate)
  if (veHr != null && input.hrVeCurve) {
    hr = {
      veLMin: veHr,
      curve: curveAt(veHr),
      label: input.hrVeCurve.label,
      minutesAbove: hrMinutesAbove(input.samples, input.hrVeCurve, upper),
    }
  }

  return { frcL: frc.frcL, frcSource: frc.source, room: { tempC: t, humidityPct: rh }, threshold, tsi, hr, references }
}

/** Seconds (1 Hz samples) whose HR-predicted VE was above each threshold, in minutes. */
export function hrMinutesAbove(
  samples: readonly Sample[],
  curve: HrVeCurve,
  thresholds: readonly [number, number],
): [number, number] {
  let a = 0
  let b = 0
  for (const s of samples) {
    const ve = veFromHr(curve, s.heartRate)
    if (ve == null) continue
    if (ve > thresholds[0]) a++
    if (ve > thresholds[1]) b++
  }
  return [a / 60, b / 60]
}
