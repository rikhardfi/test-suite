import type { JournalRaw } from './journal'
import type { FlowRecord } from './flow'
import { RH_SATURATED, flowRows, protocolClock, protocolSpans, type FlowRow } from './flowExport'
import type { MetricKey } from '../ble/types'
import type { Sample, SessionRecord } from './session'

/**
 * The research export on one uniform time grid, at the rate of the fastest
 * device in the session.
 *
 * The grid is `startedAt + k·step`. Every measurement goes into the one row
 * nearest the moment it was taken and nowhere else: a heart rate that arrived
 * once a second appears once a second, with blank rows between, because the
 * rows between were not measured. Protocol state (step, phase, targets) is the
 * exception and is carried on every row, because it is true at every instant.
 * Nothing is interpolated; an analysis that wants a held or interpolated
 * signal does that on purpose, in the open.
 *
 * Where a metric was recorded at its native rate (the journal's `raw` stream),
 * that is the source, taken only from the device that owned the metric at the
 * time. Where it was not (a session recorded before the native stream
 * existed, or in a browser), the 1 Hz snapshot is placed at its own second,
 * and the sidecar says so per column.
 */

/** Steps the grid may take, so the rate is a round number rather than a jittery median. */
const NICE_STEPS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 250, 500, 1000]

export interface GridSource {
  stream: 'flowMeter' | 'native' | 'samples'
  device: string
  intervalMs: number
  count: number
}

export type ColumnSource = 'native' | 'flowMeter' | '1 Hz snapshot' | 'held protocol state' | 'clock' | 'none'

export interface ResearchColumn {
  name: string
  unit: string
  description: string
}

interface ValueColumn extends ResearchColumn {
  metric?: MetricKey
  sample?: (s: Sample) => number | string | undefined
  flow?: (r: FlowRow) => number | null
  digits?: number
}

const HELD: ValueColumn[] = [
  { name: 'step_index', unit: '', description: 'Zero-based protocol step (held)', sample: (s) => s.stepIndex },
  { name: 'phase', unit: '', description: 'work or break (held)', sample: (s) => s.phase },
  { name: 'target_power_w', unit: 'W', description: 'Power the protocol asked for (held)', sample: (s) => s.targetPower },
  { name: 'target_speed_kph', unit: 'km/h', description: 'Speed the protocol asked for (held)', sample: (s) => s.targetKph, digits: 2 },
  { name: 'target_incline_pct', unit: '%', description: 'Gradient commanded (held)', sample: (s) => s.targetInclinePct, digits: 1 },
  {
    name: 'commanded_power_w',
    unit: 'W',
    description: 'What the machine was told, where a power correction made it differ from the target (held)',
    sample: (s) => s.commandedPower,
  },
  { name: 'power_match_factor', unit: '', description: 'Power correction in force (held)', sample: (s) => s.powerMatchFactor, digits: 4 },
  {
    name: 'power_match_held',
    unit: '',
    description: '1 when the reference meter was missing and the last correction was held (held)',
    sample: (s) => (s.powerMatchHeld ? 1 : undefined),
  },
]

const MEASURED: ValueColumn[] = [
  { name: 'power_w', unit: 'W', description: 'Measured mechanical power', metric: 'power', sample: (s) => s.power },
  {
    name: 'power_secondary_w',
    unit: 'W',
    description: "Controllable machine's own power when a separate meter supplied power_w",
    sample: (s) => s.powerSecondaryW,
  },
  { name: 'heart_rate_bpm', unit: 'bpm', description: 'Heart rate', metric: 'heartRate', sample: (s) => s.heartRate },
  { name: 'cadence_rpm', unit: 'rpm or spm', description: 'Pedal or step rate', metric: 'cadence', sample: (s) => s.cadence },
  { name: 'speed_ms', unit: 'm/s', description: 'Measured speed', metric: 'speedMs', sample: (s) => s.speedMs, digits: 3 },
  {
    name: 'incline_pct',
    unit: '%',
    description: 'Gradient as reported by the machine. From the 1 Hz snapshot it may be the commanded value; see incline_source',
    metric: 'inclinePct',
    sample: (s) => s.inclinePct,
    digits: 1,
  },
  {
    name: 'incline_source',
    unit: '',
    description: 'measured, or commanded where the 1 Hz snapshot assumed the target',
  },
  { name: 'distance_m', unit: 'm', description: 'Cumulative distance', metric: 'distanceM', sample: (s) => s.distanceM, digits: 1 },
  {
    name: 'distance_source',
    unit: '',
    description: 'machine when read from the odometer, integrated when the 1 Hz snapshot accumulated it from speed',
  },
  { name: 'resistance', unit: '', description: 'Trainer resistance level', metric: 'resistance', sample: (s) => s.resistance },
  { name: 'pedal_balance_pct', unit: '%', description: 'Left-leg share of power', metric: 'pedalBalancePct' },
  { name: 'core_temp_c', unit: 'degC', description: 'CORE estimated core temperature', metric: 'coreTempC', sample: (s) => s.coreTempC, digits: 2 },
  { name: 'skin_temp_c', unit: 'degC', description: 'CORE skin temperature', metric: 'skinTempC', sample: (s) => s.skinTempC, digits: 2 },
  { name: 'heat_strain_index', unit: '', description: 'CORE heat strain index', metric: 'heatStrainIndex', sample: (s) => s.heatStrainIndex, digits: 1 },
  { name: 'core_quality', unit: '', description: '0 invalid to 4 excellent', metric: 'coreQuality', sample: (s) => s.coreQuality },
  { name: 'core_hrm_state', unit: '', description: '0 unsupported, 1 not receiving, 2 receiving', metric: 'coreHrmState', sample: (s) => s.coreHrmState },
  { name: 'ventilation_l_min', unit: 'L/min', description: 'Ventilation wearable: minute ventilation', metric: 'ventilationLMin', digits: 1 },
  { name: 'breathing_rate_min', unit: '1/min', description: 'Ventilation wearable: breaths per minute', metric: 'breathingRate', digits: 1 },
  {
    name: 'vo2_est_ml_kg_min',
    unit: 'mL/kg/min',
    description: 'ESTIMATED oxygen cost from a population regression, computed once a second; not a measurement',
    sample: (s) => s.vo2Est,
    digits: 2,
  },
  { name: 'vo2_method', unit: '', description: 'Equation behind vo2_est_ml_kg_min', sample: (s) => s.vo2Method },
]

const FLOW: ValueColumn[] = [
  { name: 'flow_l_min', unit: 'L/min', description: 'TSI exhaled flow; standard or volumetric per flowMeter.flowUnits', flow: (r) => r.flow, digits: 3 },
  { name: 'gas_temp_c', unit: 'degC', description: 'TSI gas temperature in the flow tube', flow: (r) => r.tempC, digits: 2 },
  { name: 'abs_pressure_kpa', unit: 'kPa', description: 'TSI absolute pressure', flow: (r) => r.pressureKpa, digits: 2 },
  { name: 'rh_pct', unit: '%', description: 'TSI relative humidity near the inlet; responds over seconds', flow: (r) => r.rhPct, digits: 1 },
  {
    name: 'rh_valid',
    unit: '',
    description: `0 when rh_pct >= ${RH_SATURATED} (condensation: not a reading)`,
    flow: (r) => (r.rhPct == null ? null : r.rhPct < RH_SATURATED ? 1 : 0),
  },
  { name: 'circuit_pressure_cmh2o', unit: 'cmH2O', description: 'TSI breathing-circuit pressure', flow: (r) => r.lowPressureCmH2O, digits: 2 },
  { name: 'totalizer_l', unit: 'L', description: 'TSI running volume since power-on or reset', flow: (r) => r.totalL, digits: 3 },
  {
    name: 'flow_gap',
    unit: '',
    description: '1 where the TSI meter was restarting its stream and sent nothing (all TSI columns blank)',
  },
]

const CLOCK: ResearchColumn[] = [
  { name: 'unix_ms', unit: 'ms', description: 'Grid time: session start + row x step, ms since 1970-01-01 UTC' },
  { name: 'session_s', unit: 's', description: 'Seconds since the session started, wall clock' },
  { name: 'elapsed_s', unit: 's', description: 'Protocol clock (stands still while paused); blank before the start' },
  { name: 'running', unit: '', description: '1 while the protocol clock was running' },
]

/** The research CSV, in order. Append only. */
export const RESEARCH_COLUMNS: readonly ResearchColumn[] = [...CLOCK, ...HELD, ...MEASURED, ...FLOW].map(
  ({ name, unit, description }) => ({ name, unit, description }),
)

const median = (values: number[]): number => {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The largest round step no longer than the fastest source's interval. */
export function gridStep(intervalsMs: number[]): number {
  const fastest = Math.min(1000, ...intervalsMs.filter((v) => Number.isFinite(v) && v > 0))
  return [...NICE_STEPS_MS].reverse().find((step) => step <= fastest + 1e-9) ?? 1
}

/** Which device owned each metric over time, from the `sourceChanged` events. */
function ownership(session: SessionRecord): (metric: string, at: number, device: string) => boolean {
  const changes = new Map<string, { at: number; to: string }[]>()
  for (const event of session.events ?? []) {
    if (event.kind !== 'sourceChanged' || !event.data) continue
    const metric = String(event.data.metric)
    const list = changes.get(metric) ?? []
    list.push({ at: event.at, to: String(event.data.to ?? '') })
    changes.set(metric, list)
  }
  for (const list of changes.values()) list.sort((a, b) => a.at - b.at)
  return (metric, at, device) => {
    const list = changes.get(metric)
    // No record of who owned it: whoever reported it is the only candidate.
    if (!list?.length) return true
    let owner: string | null = null
    for (const change of list) {
      if (change.at > at) break
      owner = change.to
    }
    // Before the first resolution the manager had not chosen yet; accept.
    return owner === null || owner === device
  }
}

/** Wall time at which the runner's clock read `t` seconds. */
function wallTimeOf(session: SessionRecord): (t: number) => number {
  const spans = protocolSpans(session.events)
  return (t) => {
    for (const span of spans) {
      const length = (span.to - span.from) / 1000
      if (t <= span.offset + length + 1e-9) return span.from + Math.max(0, t - span.offset) * 1000
    }
    const last = spans.at(-1)
    return last ? last.from + (t - last.offset) * 1000 : session.startedAt + t * 1000
  }
}

export interface ResearchGrid {
  stepMs: number
  rows: number
  sources: GridSource[]
  columnSources: Record<string, ColumnSource>
  /** Measurements that shared a row with a closer one of the same column, and were left out. */
  displaced: Record<string, number>
  /**
   * Measurements timed before the session started (the flow meter streams
   * before Start, and its first block can reach back up to a second), which
   * have no row on a grid that begins at the start.
   */
  beforeStart: Record<string, number>
  /** The CSV in pieces, so a long recording never has to be one string. */
  csvParts: string[]
}

export function buildResearchGrid(
  session: SessionRecord,
  raw: readonly JournalRaw[],
  flow: readonly FlowRecord[] | null,
): ResearchGrid {
  const start = session.startedAt
  const flowData = flow?.length ? flowRows(flow) : []
  const owned = ownership(session)
  const wallOf = wallTimeOf(session)

  // --- the step: the fastest device decides ---------------------------------
  const sources: GridSource[] = []
  const flowReal = flowData.filter((r) => !r.gap)
  if (flowReal.length) {
    const dt = median(flowReal.slice(1, 2001).map((r, i) => r.unixMs - flowReal[i].unixMs))
    sources.push({ stream: 'flowMeter', device: 'tsi:flow', intervalMs: Math.round(dt * 1000) / 1000, count: flowReal.length })
  }
  const byDevice = new Map<string, number[]>()
  for (const record of raw) {
    const list = byDevice.get(record.d) ?? []
    list.push(record.at)
    byDevice.set(record.d, list)
  }
  for (const [device, ats] of byDevice) {
    if (ats.length < 2) continue
    const intervals = ats.slice(1).map((at, i) => at - ats[i]).filter((v) => v > 0)
    sources.push({ stream: 'native', device, intervalMs: median(intervals), count: ats.length })
  }
  sources.push({ stream: 'samples', device: 'runner', intervalMs: 1000, count: session.samples.length })
  const stepMs = gridStep(sources.map((s) => s.intervalMs))

  const ends = [
    session.endedAt ?? start,
    flowData.at(-1)?.unixMs ?? start,
    raw.at(-1)?.at ?? start,
    session.samples.length ? wallOf(session.samples.at(-1)!.t) : start,
  ]
  const n = Math.max(1, Math.floor((Math.max(...ends) - start) / stepMs) + 1)
  const slotOf = (at: number) => Math.round((at - start) / stepMs)

  // --- columns ---------------------------------------------------------------
  const columns = [...HELD, ...MEASURED, ...FLOW]
  const values = new Map<string, (number | string | undefined)[]>()
  const distance = new Map<string, Float64Array>()
  const displaced: Record<string, number> = {}
  const columnSources: Record<string, ColumnSource> = {}
  for (const column of CLOCK) columnSources[column.name] = 'clock'
  for (const column of columns) {
    values.set(column.name, new Array(n))
    distance.set(column.name, new Float64Array(n).fill(Infinity))
    columnSources[column.name] = 'none'
  }

  const beforeStart: Record<string, number> = {}
  const place = (name: string, at: number, value: number | string | undefined | null) => {
    if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return
    const slot = slotOf(at)
    if (slot < 0) {
      beforeStart[name] = (beforeStart[name] ?? 0) + 1
      return
    }
    if (slot >= n) return
    const off = Math.abs(at - (start + slot * stepMs))
    const d = distance.get(name)!
    if (values.get(name)![slot] !== undefined) {
      displaced[name] = (displaced[name] ?? 0) + 1
      if (off >= d[slot]) return
    }
    values.get(name)![slot] = value
    d[slot] = off
  }

  // Flow meter rows.
  for (const row of flowData) {
    if (row.gap) {
      const slot = slotOf(row.unixMs)
      if (slot >= 0 && slot < n) values.get('flow_gap')![slot] = 1
      continue
    }
    for (const column of FLOW) if (column.flow) place(column.name, row.unixMs, column.flow(row))
  }
  if (flowReal.length) {
    for (const column of FLOW) columnSources[column.name] = 'flowMeter'
  }

  // Native-rate notifications, from the device that owned each metric.
  const nativeMetrics = new Set<string>()
  for (const record of raw) {
    for (const column of MEASURED) {
      if (!column.metric) continue
      const value = record.v[column.metric]
      if (value == null || !owned(column.metric, record.at, record.d)) continue
      place(column.name, record.at, value)
      nativeMetrics.add(column.name)
      if (column.name === 'incline_pct') place('incline_source', record.at, 'measured')
      if (column.name === 'distance_m') place('distance_source', record.at, 'machine')
    }
  }
  for (const name of nativeMetrics) columnSources[name] = 'native'
  if (nativeMetrics.has('incline_pct')) columnSources.incline_source = 'native'
  if (nativeMetrics.has('distance_m')) columnSources.distance_source = 'native'

  // The 1 Hz snapshot: protocol state held, and measurements with no native
  // record placed at their own second.
  const samples = session.samples.map((sample) => ({ sample, at: wallOf(sample.t) }))
  for (const { sample, at } of samples) {
    for (const column of MEASURED) {
      if (!column.sample || nativeMetrics.has(column.name)) continue
      const value = column.sample(sample)
      if (value == null) continue
      place(column.name, at, value)
      columnSources[column.name] = '1 Hz snapshot'
      if (column.name === 'incline_pct') {
        place('incline_source', at, sample.inclineFromTarget ? 'commanded' : 'measured')
        columnSources.incline_source = '1 Hz snapshot'
      }
      if (column.name === 'distance_m') {
        place('distance_source', at, sample.distanceIntegrated ? 'integrated' : 'machine')
        columnSources.distance_source = '1 Hz snapshot'
      }
    }
  }
  for (const column of HELD) {
    const out = values.get(column.name)!
    let next = 0
    let current: number | string | undefined
    for (let slot = 0; slot < n; slot++) {
      const time = start + slot * stepMs
      while (next < samples.length && samples[next].at <= time + stepMs / 2) {
        current = column.sample!(samples[next].sample)
        next += 1
      }
      out[slot] = current
    }
    if (samples.some(({ sample }) => column.sample!(sample) != null)) columnSources[column.name] = 'held protocol state'
  }

  // --- the CSV ------------------------------------------------------------------
  const clock = protocolClock(session.events)
  const format = (column: ValueColumn, value: number | string | undefined) =>
    value === undefined ? '' : typeof value === 'number' && column.digits != null ? value.toFixed(column.digits) : String(value)
  const parts: string[] = [RESEARCH_COLUMNS.map((c) => c.name).join(',') + '\n']
  let chunk = ''
  for (let slot = 0; slot < n; slot++) {
    const unix = start + slot * stepMs
    const time = clock(unix)
    let line = `${unix},${(slot * stepMs / 1000).toFixed(3)},${time.elapsedS == null ? '' : time.elapsedS.toFixed(3)},${time.running ? 1 : 0}`
    for (const column of columns) line += `,${format(column, values.get(column.name)![slot])}`
    chunk += line + '\n'
    if (slot % 5000 === 4999) {
      parts.push(chunk)
      chunk = ''
    }
  }
  if (chunk) parts.push(chunk)

  return { stepMs, rows: n, sources, columnSources, displaced, beforeStart, csvParts: parts }
}

/** What the sidecar says about the grid. */
export function gridSidecar(grid: ResearchGrid) {
  return {
    rateHz: 1000 / grid.stepMs,
    stepMs: grid.stepMs,
    rows: grid.rows,
    rule:
      'One uniform grid from session start at the rate of the fastest device. Each measurement is in the one ' +
      'row nearest the time it was taken and blank elsewhere; nothing is held or interpolated, except protocol ' +
      'state (step, phase, targets), which is carried on every row because it is true at every instant.',
    sources: grid.sources,
    columnSources: grid.columnSources,
    displaced: grid.displaced,
    beforeStart: grid.beforeStart,
    timeBasis: {
      flowMeter: 'Sample time, re-timed from the meter’s fixed interval (see flowMeter.timing).',
      native: 'Arrival time at the computer, which includes Bluetooth latency (typically tens of ms).',
      '1 Hz snapshot': 'The runner’s one-second tick, which merges the latest values; not a measurement time.',
    },
  }
}
