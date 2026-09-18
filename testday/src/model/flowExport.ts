import type { FlowBlock, FlowCommand, FlowMeterRecord, FlowRecord, FlowSegment } from './flow'
import type { Sample, SessionEvent, SessionRecord } from './session'

/**
 * The flow meter in the exports: the full-rate rows re-timed and laid on a
 * continuous grid, the protocol clock they share with the 1 Hz series, a
 * per-second summary for that series, and what the sidecar needs to say.
 *
 * The same re-timing as the R reader (`read_testday_flow`), so an analysis in
 * either place starts from identical rows.
 */

/** Relative humidity from here up is condensation, not a reading. */
export const RH_SATURATED = 99.5

export interface FlowRow {
  unixMs: number
  seg: number
  /** Index within the segment; negative for rows inserted in the gap before it. */
  index: number
  gap: boolean
  flow: number | null
  tempC: number | null
  pressureKpa: number | null
  rhPct: number | null
  lowPressureCmH2O: number | null
  totalL: number | null
}

/** The final record for each segment: a later record supersedes a partial one. */
function finalSegments(records: readonly FlowRecord[]): Map<number, FlowSegment> {
  const out = new Map<number, FlowSegment>()
  for (const record of records) if (record.type === 'segment') out.set(record.seg, record)
  return out
}

/**
 * Every row on its sample time, in order, with empty rows where the meter's
 * stream restarted. A segment with no timing record (a recording cut off by a
 * crash) falls back to its blocks' provisional times.
 */
export function flowRows(records: readonly FlowRecord[]): FlowRow[] {
  const segments = finalSegments(records)
  const rows: FlowRow[] = []
  const present = new Set<number>()

  for (const record of records) {
    if (record.type !== 'block') continue
    const block = record as FlowBlock
    present.add(block.seg)
    const segment = segments.get(block.seg)
    for (let k = 0; k < block.f.length; k++) {
      const index = block.i0 + k
      rows.push({
        unixMs: segment ? segment.anchorAt + index * block.dt : block.at0 + k * block.dt,
        seg: block.seg,
        index,
        gap: false,
        flow: block.f[k],
        tempC: block.tc[k],
        pressureKpa: block.p[k],
        rhPct: block.rh[k],
        lowPressureCmH2O: block.lp[k],
        totalL: block.tot[k],
      })
    }
  }

  for (const segment of segments.values()) {
    const samples = segment.gapBefore?.samples ?? 0
    if (samples <= 0 || !present.has(segment.seg) || !present.has(segment.seg - 1)) continue
    for (let m = samples; m >= 1; m--) {
      rows.push({
        unixMs: segment.anchorAt - m * segment.dt,
        seg: segment.seg,
        index: -m,
        gap: true,
        flow: null,
        tempC: null,
        pressureKpa: null,
        rhPct: null,
        lowPressureCmH2O: null,
        totalL: null,
      })
    }
  }

  return rows.sort((a, b) => a.unixMs - b.unixMs)
}

export interface ProtocolTime {
  /** The runner's clock, which the 1 Hz series is on. Null before the test started. */
  elapsedS: number | null
  running: boolean
}

/**
 * Maps wall-clock time onto the protocol clock that `elapsed_s` in the sample
 * CSV uses. That clock stands still while the test is paused, so it is rebuilt
 * from the start, pause and resume events: elapsed time is the running time
 * accumulated so far. A jump between steps does not move it.
 *
 * After a session is resumed from disk the runner restarts its clock from the
 * last sample on disk, which can differ from this reconstruction by up to a
 * second.
 */
export interface ProtocolSpan {
  from: number
  to: number
  /** Protocol seconds already accumulated when this span began. */
  offset: number
}

/** The stretches of wall-clock time during which the protocol clock ran. */
export function protocolSpans(events: readonly SessionEvent[] | undefined): ProtocolSpan[] {
  const spans: ProtocolSpan[] = []
  let runningSince: number | null = null
  let accumulated = 0
  const sorted = [...(events ?? [])].sort((a, b) => a.at - b.at)
  for (const event of sorted) {
    if ((event.kind === 'start' || event.kind === 'resume') && runningSince === null) {
      runningSince = event.at
    } else if (event.kind === 'pause' && runningSince !== null) {
      spans.push({ from: runningSince, to: event.at, offset: accumulated })
      accumulated += (event.at - runningSince) / 1000
      runningSince = null
    }
  }
  if (runningSince !== null) spans.push({ from: runningSince, to: Infinity, offset: accumulated })
  return spans
}

export function protocolClock(events: readonly SessionEvent[] | undefined): (unixMs: number) => ProtocolTime {
  const spans = protocolSpans(events)

  return (unixMs) => {
    if (!spans.length || unixMs < spans[0].from) return { elapsedS: null, running: false }
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]
      if (unixMs < span.from) {
        // Paused between two spans: the clock holds where the previous one ended.
        const previous = spans[i - 1]
        return { elapsedS: previous.offset + (previous.to - previous.from) / 1000, running: false }
      }
      if (unixMs < span.to) return { elapsedS: span.offset + (unixMs - span.from) / 1000, running: true }
    }
    const last = spans[spans.length - 1]
    return { elapsedS: last.offset + (last.to - last.from) / 1000, running: false }
  }
}

// --- the 1 Hz summary ---------------------------------------------------------------

/**
 * Adds the flow meter to each 1 Hz sample: the means over the second of
 * protocol time that ends at the sample's `t`, while the clock was running.
 *
 * Humidity is left blank for a second that contains any saturated row, rather
 * than averaged with it. Coverage says how much of the second the meter
 * actually sent, so a second that straddles a stream restart can be seen.
 */
export function withExhaled(session: SessionRecord, rows: readonly FlowRow[]): SessionRecord {
  if (!rows.length || !session.samples.length) return session
  const clock = protocolClock(session.events)
  const dtMs = medianStep(rows)

  interface Acc {
    n: number
    flow: number
    temp: number
    rh: number
    rhN: number
    saturated: boolean
  }
  const bins = new Map<number, Acc>()
  for (const row of rows) {
    const time = clock(row.unixMs)
    if (!time.running || time.elapsedS == null) continue
    const t = Math.ceil(time.elapsedS)
    let acc = bins.get(t)
    if (!acc) {
      acc = { n: 0, flow: 0, temp: 0, rh: 0, rhN: 0, saturated: false }
      bins.set(t, acc)
    }
    if (row.gap || row.flow == null) continue
    acc.n += 1
    acc.flow += row.flow
    acc.temp += row.tempC ?? 0
    if (row.rhPct != null) {
      if (row.rhPct >= RH_SATURATED) acc.saturated = true
      acc.rh += row.rhPct
      acc.rhN += 1
    }
  }

  const perSecond = dtMs > 0 ? 1000 / dtMs : 0
  const samples: Sample[] = session.samples.map((sample) => {
    const acc = bins.get(sample.t)
    if (!acc || acc.n === 0) return sample
    return {
      ...sample,
      exhaledFlowLMin: acc.flow / acc.n,
      exhaledGasTempC: acc.temp / acc.n,
      exhaledRhPct: acc.saturated || acc.rhN === 0 ? undefined : acc.rh / acc.rhN,
      exhaledCoverage: perSecond ? Math.min(1, acc.n / perSecond) : undefined,
    }
  })
  return { ...session, samples }
}

function medianStep(rows: readonly FlowRow[]): number {
  const steps: number[] = []
  for (let i = 1; i < rows.length && steps.length < 2000; i++) steps.push(rows[i].unixMs - rows[i - 1].unixMs)
  steps.sort((a, b) => a - b)
  return steps.length ? Math.round(steps[Math.floor(steps.length / 2)] * 1000) / 1000 : 0
}

// --- the sidecar ---------------------------------------------------------------------

export interface FlowSidecar {
  meter: Omit<FlowMeterRecord, 'type' | 'at' | 'host'> | null
  rows: number
  segments: number
  gaps: { count: number; totalMs: number; volumeL: number; unmeasured: number }
  humiditySaturatedShare: number
  commands: { at: string; command: FlowCommand['command']; ok: boolean }[]
  timing: string
  caveats: string[]
}

export function flowSidecar(records: readonly FlowRecord[], rows: readonly FlowRow[]): FlowSidecar {
  const meterRecord = [...records].reverse().find((r): r is FlowMeterRecord => r.type === 'meter') ?? null
  const segments = [...finalSegments(records).values()]
  // Only gaps inside this recording: a session that began while the meter was
  // already streaming has a first segment whose gap happened before it.
  const recorded = new Set(records.filter((r) => r.type === 'block').map((r) => (r as FlowBlock).seg))
  const gaps = segments.filter((s) => s.gapBefore && recorded.has(s.seg) && recorded.has(s.seg - 1))
  const measured = rows.filter((r) => !r.gap && r.rhPct != null)
  const standard = meterRecord?.flowUnits !== 'V'

  return {
    meter: meterRecord
      ? (({ type: _t, at: _a, host: _h, ...rest }) => rest)(meterRecord)
      : null,
    rows: rows.filter((r) => !r.gap).length,
    segments: segments.length,
    gaps: {
      count: gaps.length,
      totalMs: Math.round(gaps.reduce((sum, s) => sum + Math.max(0, s.gapBefore!.ms), 0)),
      volumeL: Number(gaps.reduce((sum, s) => sum + (s.gapBefore!.volumeL ?? 0), 0).toFixed(4)),
      unmeasured: gaps.filter((s) => s.gapBefore!.volumeL == null).length,
    },
    humiditySaturatedShare: measured.length
      ? Number((measured.filter((r) => r.rhPct! >= RH_SATURATED).length / measured.length).toFixed(4))
      : 0,
    commands: records
      .filter((r): r is FlowCommand => r.type === 'command')
      .map((c) => ({ at: new Date(c.at).toISOString(), command: c.command, ok: c.ok })),
    timing:
      'Rows reach the computer in bursts, so arrival time is not sample time. The meter samples on a fixed ' +
      'interval; each 30 s stream segment is anchored at min(arrival_i - i*dt) over its rows and row i is ' +
      'placed at anchor + i*dt. Residual error is the ~1 ms network transport plus the meter averaging window ' +
      '(a row is the mean of the dt before its time).',
    caveats: [
      standard
        ? 'Flow is STANDARD L/min of humidity-compensated dry gas at 21.11 degC and 101.3 kPa, not BTPS. Convert before comparing with ventilation.'
        : 'Flow is volumetric L/min at the measured gas temperature and pressure, not BTPS.',
      meterRecord && !meterRecord.directionSensor
        ? 'The direction sensor was off: reverse flow reads positive. Valid only on a one-way expiratory limb.'
        : 'Direction sensing was on: reverse flow reads negative.',
      'The humidity sensor responds over seconds: use rh_pct for averages across breaths, never within a breath.',
      `rh_pct at or above ${RH_SATURATED} % is condensation and carries no information about the gas.`,
      'Humidity is measured near the inlet and temperature in the flow tube, which the flow sensor warms at low flow; absolute humidity from these two assumes they describe the same gas.',
      'The meter restarts its stream every 30 s and those rows do not exist (flow_gap = 1). The volume that passed in each gap is from the meter totalizer.',
      'TSI states these meters are not medical devices and are not intended for human respiration measurements.',
    ],
  }
}
