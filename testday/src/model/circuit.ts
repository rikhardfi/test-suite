import type { FlowRows } from './breaths'

/**
 * Something other than the athlete blowing through the meter.
 *
 * Between subjects the circuit is dried with a table fan or a hair dryer, and
 * both push steady flow through the meter in the exhaled direction. Breathing
 * never does: an exhalation ends within seconds, and the ventilation project
 * already treats any "exhalation" over 8 s as fan or dryer flow
 * (`cfg$tsi$report$max_breath_s`). So flow that stays positive through ten
 * seconds is the circuit, not the athlete.
 *
 * Positive flow alone is not enough. At high ventilation exhalation takes over
 * half of each breath, and on 2026-10-02 the meter showed inspiration as a
 * positive hump of 20 to 40 L/min with only brief dips below zero: windows of
 * breathing were over 95 % positive, and a hold that waited for flow to stop
 * never let go. So the shape decides as well. The fan and the dryer are steady;
 * breathing swings by tens of L/min with every breath. A window that swings by
 * 30 L/min or more and rises through that swing at least twice is breathing,
 * whatever the sign of the flow: nothing is detected, and a hold ends. A window
 * with a swing that large is never newly read as fan or dryer either, so the
 * tail of a bout cannot read as the dryer for a second.
 *
 * Fan and dryer separate on flow and heat. On the 2026-09-30 recordings the fan
 * ran at 6 to 13 L/min with the gas settling to room temperature, and the dryer
 * at 29 to 50 L/min with the gas at 23 to 62 °C. Either 25 L/min or 40 °C puts
 * a stretch on the dryer side; both thresholds sit well clear of the fan.
 *
 * This is inference from the gas. The operator's markers say what was actually
 * on the circuit, and the two are journalled as different events so neither can
 * be mistaken for the other.
 *
 * Pure.
 */

export type CircuitFlow = 'fan' | 'dryer'

export const CIRCUIT_SETTINGS = {
  windowS: 10,
  /** Flow at or below this counts as the flow having stopped. */
  minFlowLMin: 1,
  /** Share of the window's rows above `minFlowLMin`. */
  minPositiveShare: 0.95,
  /** Rows the meter actually sent, as a share of the window. */
  minCoverage: 0.8,
  dryerFlowLMin: 25,
  dryerTempC: 40,
  /**
   * Once on, the state holds until flow has stopped: most of this many seconds
   * at or below `minFlowLMin`. A dip or a stream restart in a fan run is not
   * the fan going off (2026-09-30: without this, a fan run read off and on
   * again ten seconds later).
   */
  stopS: 2,
  /**
   * Breathing swings; the fan and the dryer do not. A window whose flow swings
   * by at least this much (5th to 95th percentile) and rises through the middle
   * of that swing at least `breathingCycles` times is breathing, whatever the
   * sign of the flow. It is never the circuit and it ends a hold.
   */
  breathingSwingLMin: 30,
  breathingCycles: 2,
} as const

export interface CircuitState {
  kind: CircuitFlow
  /** Means over the window. */
  flowLMin: number
  tempC: number
}

/**
 * What is on the circuit over the last `windowS` of the rows, or null when it
 * is breathing or nothing. `previous` is the last answer, for the hold.
 */
export function detectCircuit(
  rows: FlowRows,
  previous: CircuitFlow | null = null,
  settings = CIRCUIT_SETTINGS,
): CircuitState | null {
  const window = Math.round(settings.windowS / rows.dtS)
  const n = rows.flow.length
  if (n < window) return null
  const swing = swings(rows, n - window, settings)
  if (swing.rises >= settings.breathingCycles) return null
  const held = previous != null && !stopped(rows, settings)
  let sent = 0
  let positive = 0
  let flowSum = 0
  let tempSum = 0
  let tempCount = 0
  for (let i = n - window; i < n; i++) {
    const f = rows.flow[i]
    if (!Number.isFinite(f)) continue
    sent += 1
    flowSum += f
    if (f > settings.minFlowLMin) positive += 1
    const t = rows.tempC[i]
    if (Number.isFinite(t)) {
      tempSum += t
      tempCount += 1
    }
  }
  const steady =
    sent >= settings.minCoverage * window &&
    positive >= settings.minPositiveShare * sent &&
    swing.swingLMin < settings.breathingSwingLMin
  if (!steady && !held) return null
  if (!sent) return null
  const flowLMin = flowSum / sent
  const tempC = tempCount ? tempSum / tempCount : NaN
  const kind: CircuitFlow = flowLMin >= settings.dryerFlowLMin || tempC >= settings.dryerTempC ? 'dryer' : 'fan'
  return { kind: steady ? kind : previous!, flowLMin, tempC }
}

function stopped(rows: FlowRows, settings: typeof CIRCUIT_SETTINGS): boolean {
  const n = rows.flow.length
  const from = Math.max(0, n - Math.round(settings.stopS / rows.dtS))
  let sent = 0
  let low = 0
  for (let i = from; i < n; i++) {
    const f = rows.flow[i]
    if (!Number.isFinite(f)) continue
    sent += 1
    if (f <= settings.minFlowLMin) low += 1
  }
  return sent === 0 || low > sent / 2
}

/**
 * How far the flow swings from `from` to the end of the rows (5th to 95th
 * percentile), and how often it rises from the bottom quarter of that swing to
 * the top quarter. A step, such as the dryer going to a higher setting, rises
 * once; breathing rises every breath.
 */
function swings(rows: FlowRows, from: number, settings: typeof CIRCUIT_SETTINGS): { swingLMin: number; rises: number } {
  const flow: number[] = []
  for (let i = from; i < rows.flow.length; i++) if (Number.isFinite(rows.flow[i])) flow.push(rows.flow[i])
  if (flow.length < 2) return { swingLMin: 0, rises: 0 }
  const sorted = [...flow].sort((a, b) => a - b)
  const lo = sorted[Math.floor(0.05 * (sorted.length - 1))]
  const hi = sorted[Math.ceil(0.95 * (sorted.length - 1))]
  const swingLMin = hi - lo
  if (swingLMin < settings.breathingSwingLMin) return { swingLMin, rises: 0 }
  const below = lo + swingLMin / 4
  const above = hi - swingLMin / 4
  let low = false
  let rises = 0
  for (const f of flow) {
    if (f < below) low = true
    else if (f > above && low) {
      rises += 1
      low = false
    }
  }
  return { swingLMin, rises }
}
