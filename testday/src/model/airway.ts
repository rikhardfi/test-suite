import { saturationPressurePa } from './humidity'
import type { Exhalation } from './breaths'

/**
 * What the airway gives the air, measured at the TSI meter.
 *
 * Per exhalation, three quantities, all for the same mass of dry air:
 *
 * - **Lost**: the energy the exhaled gas carries beyond the room air that was
 *   breathed in, sensible plus latent. `tsi_breath_energy()` in the ventilation
 *   project (`R/tsi.R`), plateau reading.
 * - **Demand**: what bringing that room air to 37 °C and saturation costs. The
 *   inspiratory side of the same balance.
 * - **Recovered**: demand minus lost, the heat and water handed back to the
 *   airway wall on the way out.
 *
 * Latent heat is `2501 − 2.361·T` kJ/kg throughout, at the gas's own
 * temperature, as in `R/tsi.R`. Not the season pipeline's 2260 kJ/kg (water at
 * 100 °C), which is an open question there; using one constant on both sides
 * keeps the difference a difference of like quantities.
 *
 * The meter is downstream of mask, saliva trap and tubing, and its humidity
 * sensor lags the breath. Exhaled values are therefore lower bounds on the gas
 * at the mouth: lost is understated and recovered overstated, by an amount no
 * one has measured. Every tile built on this says "at the meter".
 *
 * Pure.
 */

const GAS_CONSTANT = 8.314462618
const MW_AIR = 28.97
const MW_WATER = 18.015
/** kJ/(kg K), `cfg$thermodynamics$specific_heat_air_kj_kgc`. */
const CP_AIR = 1.006
const BODY_TEMP_C = 37
/** The meter's standard conditions (TSI). */
const STD_TEMP_C = 21.11
const STD_PRESSURE_PA = 101325
const SEA_LEVEL_PA = 101325

/** Karamaoun et al. 2022: tracheal surface liquid dehydrates above 85 L/min at 19 °C, 55 %. */
export const KARAMAOUN_REF = { tempC: 19, humidityPct: 55, veLMin: 85, pressurePa: SEA_LEVEL_PA } as const

/** kJ/kg at the given temperature. `latent_heat_kj_kg()` in R/tsi.R. */
export const latentHeatKjKg = (tempC: number): number => 2501 - 2.361 * tempC

/** kg water per kg dry air. `calculate_mixing_ratio()` in R/thermodynamics.R. */
export function mixingRatio(vapourPa: number, pressurePa: number): number {
  if (vapourPa >= pressurePa) return NaN
  return (MW_WATER / MW_AIR) * (vapourPa / (pressurePa - vapourPa))
}

const mixingRatioOf = (tempC: number, rhPct: number, pressurePa: number): number =>
  mixingRatio((rhPct / 100) * saturationPressurePa(tempC), pressurePa)

/** Density of the meter's standard dry gas, kg/m³ (1.1998). `tsi_standard_density()`. */
export const STD_DENSITY = (STD_PRESSURE_PA * (MW_AIR / 1000)) / (GAS_CONSTANT * (STD_TEMP_C + 273.15))

/** Standard dry litres to BTPS at this barometric pressure, with R's 6.275 kPa for water at 37 °C. `tsi_btps_factor()`. */
export const btpsFactor = (pressurePa: number): number =>
  (310.15 / (STD_TEMP_C + 273.15)) * (101.325 / (pressurePa / 1000 - 6.275))

/** Moist-air density, kg/m³. `air_density_kg_m3()` in R/altitude.R. */
export function airDensity(tempC: number, humidityPct: number, pressurePa: number): number {
  const tk = tempC + 273.15
  const pv = (humidityPct / 100) * saturationPressurePa(tempC)
  return (pressurePa - pv) / (287.058 * tk) + pv / (461.495 * tk)
}

/**
 * VE above which tracheal surface liquid dehydrates in this air, L/min BTPS.
 *
 * `calculate_ve_threshold()` in R/dehydration.R in its session-air form: the
 * threshold is the water flux (density × humidity deficit against body air)
 * that the reference air produces at 85 L/min. Colder or drier air takes more
 * water per litre, so the threshold falls. Infinity when the air is already at
 * body water content.
 */
export function karamaounThresholdLMin(tempC: number, humidityPct: number, pressurePa = SEA_LEVEL_PA): number {
  const deficit = (t: number, rh: number, p: number) =>
    mixingRatio(saturationPressurePa(BODY_TEMP_C), p) - mixingRatioOf(t, rh, p)
  const ref = KARAMAOUN_REF
  const fluxRef = airDensity(ref.tempC, ref.humidityPct, ref.pressurePa) * deficit(ref.tempC, ref.humidityPct, ref.pressurePa)
  const d = deficit(tempC, humidityPct, pressurePa)
  if (!(d > 0)) return Infinity
  return ref.veLMin * (fluxRef / (airDensity(tempC, humidityPct, pressurePa) * d))
}

export interface Room {
  tempC: number
  humidityPct: number
}

export interface BreathEnergy {
  lostJ: number
  demandJ: number
  /** Net water to the exhaled gas, mg. */
  waterMg: number
}

/** One exhalation against the room air that was breathed in. */
export function breathEnergy(breath: Exhalation, room: Room): BreathEnergy {
  const mass = (breath.volumeStdL / 1000) * STD_DENSITY
  const p = breath.pressurePa
  const qRoom = mixingRatioOf(room.tempC, room.humidityPct, p)
  const qOut = mixingRatioOf(breath.tempC, breath.rhPct, p)
  const qBody = mixingRatioOf(BODY_TEMP_C, 100, p)
  const water = mass * (qOut - qRoom)
  const lostKj = mass * CP_AIR * (breath.tempC - room.tempC) + water * latentHeatKjKg(breath.tempC)
  const demandKj =
    mass * CP_AIR * (BODY_TEMP_C - room.tempC) + mass * (qBody - qRoom) * latentHeatKjKg(BODY_TEMP_C)
  return { lostJ: lostKj * 1000, demandJ: demandKj * 1000, waterMg: water * 1e6 }
}

export interface AirwayLoad {
  windowS: number
  /** Exhalations whose end fell in the window. */
  breaths: number
  /** From the TSI, BTPS. */
  veLMin: number
  lostKjH: number
  demandKjH: number
  recoveredKjH: number
  /** Recovered as a share of demand, %. */
  recoveredPct: number
  waterLostGH: number
  /** Share of the window's exhalations whose plateau was condensation. */
  saturatedShare: number
  karamaoun: {
    thresholdLMin: number
    /** Minutes since `since` in which the 30 s VE was above the threshold. */
    minutesAbove: number | null
  }
}

export interface AirwayOptions {
  /** End of the data, ms: the meter's latest row. */
  now: number
  room: Room
  /** Barometric pressure, Pa. The meter's own reading when nothing better is known. */
  pressurePa?: number
  /** Start of the test, ms, for time above the threshold. */
  since?: number
  windowS?: number
}

/**
 * The last 30 s of exhalations as hourly rates, and the Karamaoun threshold.
 *
 * Null until the log covers a whole window, and when the meter has seen no
 * exhalation for ten seconds (mask off, meter off): a window that is not full,
 * or not being breathed into, would report a fraction of a rate as a rate.
 */
export function airwayLoad(log: readonly Exhalation[], options: AirwayOptions): AirwayLoad | null {
  const windowS = options.windowS ?? 30
  const from = options.now - windowS * 1000
  if (!log.length || log[0].startAt > from) return null
  if (options.now - log[log.length - 1].endAt > 10_000) return null
  const recent = log.filter((b) => b.endAt > from && b.endAt <= options.now)
  if (recent.length < 2) return null

  const pressurePa = options.pressurePa ?? median(recent.map((b) => b.pressurePa))
  const perHour = 3600 / windowS
  let lostJ = 0
  let demandJ = 0
  let waterMg = 0
  let volume = 0
  for (const b of recent) {
    const e = breathEnergy(b, options.room)
    lostJ += e.lostJ
    demandJ += e.demandJ
    waterMg += e.waterMg
    volume += b.volumeStdL
  }
  const factor = btpsFactor(pressurePa)
  const threshold = karamaounThresholdLMin(options.room.tempC, options.room.humidityPct, pressurePa)

  return {
    windowS,
    breaths: recent.length,
    veLMin: volume * factor * (60 / windowS),
    lostKjH: (lostJ / 1000) * perHour,
    demandKjH: (demandJ / 1000) * perHour,
    recoveredKjH: ((demandJ - lostJ) / 1000) * perHour,
    recoveredPct: demandJ > 0 ? (100 * (demandJ - lostJ)) / demandJ : NaN,
    waterLostGH: (waterMg / 1000) * perHour,
    saturatedShare: recent.filter((b) => b.saturated).length / recent.length,
    karamaoun: {
      thresholdLMin: threshold,
      minutesAbove:
        options.since == null ? null : minutesAbove(log, threshold, factor, options.since, options.now, windowS),
    },
  }
}

/**
 * Minutes in which the rolling VE was above the threshold, from `since` to
 * `now`. Counted breath to breath: the interval ending at an exhalation counts
 * when the VE over the window ending there is above. Intervals longer than ten
 * seconds are gaps in the record, not breathing, and do not count.
 */
export function minutesAbove(
  log: readonly Exhalation[],
  thresholdLMin: number,
  btps: number,
  since: number,
  now: number,
  windowS = 30,
): number {
  if (!Number.isFinite(thresholdLMin)) return 0
  let seconds = 0
  let head = 0
  let volume = 0
  for (let i = 0; i < log.length; i++) {
    const b = log[i]
    if (b.endAt > now) break
    volume += b.volumeStdL
    while (log[head].endAt <= b.endAt - windowS * 1000) volume -= log[head++].volumeStdL
    if (i === 0 || b.endAt <= since) continue
    const covered = log[0].startAt <= b.endAt - windowS * 1000
    const step = (b.endAt - Math.max(log[i - 1].endAt, since)) / 1000
    const ve = volume * btps * (60 / windowS)
    if (covered && step <= 10 && ve > thresholdLMin) seconds += step
  }
  return seconds / 60
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
