import type { MetricKey } from './types'

/**
 * What each metric is, in one place.
 *
 * Adding a sensor used to mean editing `MetricKey`, the arbitration table, the
 * parser, `Sample`, the CSV writer, the sidecar and the dashboard, and the
 * label was written out again in each. The unit in particular was scattered
 * across three files and an export column header, which is how a unit ends up
 * disagreeing with itself.
 *
 * This is the single description. The sidecar, the sensor panel and the tile
 * registry all read it.
 */
export interface MetricInfo {
  label: string
  /** Empty for a dimensionless index or a state code. */
  unit: string
  /**
   * Seconds between updates from a working sensor. Used to judge staleness
   * honestly: a CO₂ monitor that reports every five minutes is not a dead
   * sensor, and treating it like one would blank a perfectly good reading.
   *
   * Stored as an interval rather than a rate because the slow channels are
   * naturally minutes, and a reciprocal of a reciprocal does not come back to
   * the number it started from.
   */
  typicalIntervalS: number
  /**
   * `metric` is sampled onto the 1 Hz series. `environment` is recorded on its
   * own slow clock and summarised per session, because carrying a value that
   * changes every five minutes at 1 Hz would produce a column that is almost
   * entirely repeats and would read as if it had been measured that often.
   */
  channel: 'metric' | 'environment'
}

export const METRIC_INFO: Record<MetricKey, MetricInfo> = {
  heartRate: { label: 'Heart rate', unit: 'bpm', typicalIntervalS: 1, channel: 'metric' },
  power: { label: 'Power', unit: 'W', typicalIntervalS: 1, channel: 'metric' },
  cadence: { label: 'Cadence', unit: 'rpm', typicalIntervalS: 1, channel: 'metric' },
  speedMs: { label: 'Speed', unit: 'm/s', typicalIntervalS: 1, channel: 'metric' },
  distanceM: { label: 'Distance', unit: 'm', typicalIntervalS: 1, channel: 'metric' },
  inclinePct: { label: 'Gradient', unit: '%', typicalIntervalS: 1, channel: 'metric' },
  resistance: { label: 'Resistance', unit: '', typicalIntervalS: 1, channel: 'metric' },
  coreTempC: { label: 'Core temperature', unit: '°C', typicalIntervalS: 2, channel: 'metric' },
  skinTempC: { label: 'Skin temperature', unit: '°C', typicalIntervalS: 2, channel: 'metric' },
  heatStrainIndex: { label: 'Heat strain index', unit: '', typicalIntervalS: 2, channel: 'metric' },
  coreQuality: { label: 'CORE reading quality', unit: '', typicalIntervalS: 2, channel: 'metric' },
  coreHrmState: { label: 'CORE strap link', unit: '', typicalIntervalS: 2, channel: 'metric' },
  ventilationLMin: { label: 'Minute ventilation', unit: 'L/min', typicalIntervalS: 1, channel: 'metric' },
  breathingRate: { label: 'Breathing rate', unit: 'breaths/min', typicalIntervalS: 1, channel: 'metric' },
  // Every one of these moves on the monitor's own schedule, which is minutes.
  co2Ppm: { label: 'CO₂', unit: 'ppm', typicalIntervalS: 300, channel: 'environment' },
  ambientTempC: { label: 'Air temperature', unit: '°C', typicalIntervalS: 300, channel: 'environment' },
  humidityPct: { label: 'Relative humidity', unit: '%', typicalIntervalS: 300, channel: 'environment' },
  pressureHpa: { label: 'Barometric pressure', unit: 'hPa', typicalIntervalS: 300, channel: 'environment' },
}

export const metricLabel = (key: MetricKey): string => METRIC_INFO[key]?.label ?? key

export const isEnvironment = (key: MetricKey): boolean =>
  METRIC_INFO[key]?.channel === 'environment'

/**
 * How long a value of this kind stays worth showing.
 *
 * A five-second rule is right for a power meter and wrong for a CO₂ monitor
 * that speaks every five minutes; applying the former to the latter would blank
 * a reading that is entirely current.
 */
export function staleAfterMs(key: MetricKey): number {
  const info = METRIC_INFO[key]
  if (!info) return 5000
  // Three missed updates, floored at five seconds so a fast sensor is not
  // declared dead over one dropped packet.
  return Math.max(5000, info.typicalIntervalS * 3 * 1000)
}
