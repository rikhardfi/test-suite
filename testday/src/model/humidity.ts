/**
 * Water in the air the athlete breathes in.
 *
 * Relative humidity says how close air is to saturated at its own temperature,
 * which is not what the airway has to deal with. What it has to deal with is
 * the mass of water missing from each litre, and that needs the temperature as
 * well: 50% at 23 °C carries about 10 mg/L, 50% at −10 °C about 1 mg/L.
 *
 * The arithmetic is the same as `tsi_water_content_mg_l()` in the ventilation
 * project (`R/tsi.R`), constant for constant, so that a figure on this
 * dashboard and a figure in that analysis are the same figure. Change one and
 * the other has to change with it.
 */

/** Gas constant, J/(mol K). */
const GAS_CONSTANT = 8.314462618
/** Molar mass of water, g/mol. */
const MOLAR_MASS_WATER = 18.015

/** Saturation vapour pressure over water, in pascals. Buck's equation. */
export function saturationPressurePa(tempC: number): number {
  return 611.21 * Math.exp((17.502 * tempC) / (tempC + 240.97))
}

/**
 * Water content in mg per litre of the air as it is, at its own temperature
 * and pressure. Not BTPS, and not per litre of dry gas. Barometric pressure
 * does not enter: only the vapour's own pressure and the temperature do.
 */
export function waterContentMgL(tempC: number, humidityPct: number): number {
  const vapourPa = (humidityPct / 100) * saturationPressurePa(tempC)
  return ((vapourPa * (MOLAR_MASS_WATER / 1000)) / (GAS_CONSTANT * (tempC + 273.15))) * 1000
}

/** The same, for a reading that may be missing either half. */
export function waterContentOf(reading: { tempC?: number | null; humidityPct?: number | null }): number | null {
  if (reading.tempC == null || reading.humidityPct == null) return null
  const value = waterContentMgL(reading.tempC, reading.humidityPct)
  return Number.isFinite(value) ? value : null
}
