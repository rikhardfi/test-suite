/**
 * The flow meter's own recording: `flow.ndjson`, next to `journal.ndjson` in
 * the session folder.
 *
 * A file of its own rather than more journal lines, because of size. At 1 ms
 * the meter produces six channels a thousand times a second, around 150 MB an
 * hour of JSON, and every path that opens a session (the list, resume, review)
 * parses the whole journal. Those paths never need the waveform. The journal
 * still gets an event for anything the operator did to the meter, so the
 * session's own history stays complete without this file.
 *
 * Written append-only with one fsync per block, like the journal. Keys are
 * short because block lines dominate the file.
 *
 * Timing: a block's `at0` is provisional, the best estimate when the block was
 * written. The final estimate for the whole segment arrives in its `segment`
 * record, and a reader re-times every row as `anchorAt + i·dt`. See
 * `electron/tsi/timing.ts` for why rows are timed from their index.
 */

export const FLOW_FILE = 'flow.ndjson'

/** Identity and settings, written when a session starts and whenever they change. */
export interface FlowMeterRecord {
  type: 'meter'
  at: number
  host: string
  model: string
  serial: string
  firmware: string
  calibrationDate: string
  rateMs: number
  /** `S` standard or `V` volumetric flow. */
  flowUnits: string
  humidityCompensation: boolean
  /** Off means reverse flow reads positive. */
  directionSensor: boolean
}

/** Consecutive rows of one segment, columnar. */
export interface FlowBlock {
  type: 'block'
  seg: number
  /** Index of the first row within its segment. */
  i0: number
  /** Provisional wall-clock time of row `i0`, ms. */
  at0: number
  dt: number
  /** Flow, Std L/min. */
  f: number[]
  /** Temperature, °C. */
  tc: number[]
  /** Absolute pressure, kPa. */
  p: number[]
  /** Relative humidity, %. */
  rh: number[]
  /** Low (differential) pressure, cmH2O. */
  lp: number[]
  /** Totalizer, L. */
  tot: number[]
}

export type SegmentStart = 'first' | 'continuous' | 'restart' | 'reconnect'

/**
 * Written when a segment ends. Its timing supersedes the blocks' `at0`. A
 * segment can have earlier `partial` records, written when a session stopped
 * recording while it was still streaming; the last record for a segment wins.
 */
export interface FlowSegment {
  type: 'segment'
  seg: number
  /** Wall-clock time of row 0, ms. */
  anchorAt: number
  n: number
  dt: number
  /** Interval as the computer's clock saw it; a drift check, not a correction. */
  observedDt: number | null
  /** How this segment began: straight after the previous one, or after a stop. */
  start: SegmentStart
  /** The segment was still streaming; `n` is the rows so far. */
  partial?: boolean
  /**
   * What was lost between the previous segment and this one. Null for the first
   * segment of a connection sequence that has nothing before it.
   */
  gapBefore: {
    samples: number
    ms: number
    /** From the meter's totalizer; null if it was reset in between. */
    volumeL: number | null
  } | null
}

export type FlowCommandKind = 'zeroLowPressure' | 'resetTotalizer' | 'rate'

/** Something sent to the meter on the operator's request. */
export interface FlowCommand {
  type: 'command'
  at: number
  command: FlowCommandKind
  ok: boolean
  detail?: string
}

export type FlowRecord = FlowMeterRecord | FlowBlock | FlowSegment | FlowCommand

export type FlowMeterState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** Pushed to the interface a few times a second. Never per row. */
export interface FlowMeterStatus {
  state: FlowMeterState
  host: string | null
  meter: Omit<FlowMeterRecord, 'type' | 'at'> | null
  rateMs: number
  /** Mean flow over the rows since the previous status. */
  flowLMin: number | null
  tempC: number | null
  humidityPct: number | null
  pressureKpa: number | null
  lowPressureCmH2O: number | null
  totalL: number | null
  /** Rows received since connecting. */
  rows: number
  gaps: number
  lastGapMs: number | null
  /** Latest RH at or above 99.5 %: likely condensation, humidity no longer meaningful. */
  humiditySaturated: boolean
  error: string | null
}

const FLOW_TYPES = new Set(['meter', 'block', 'segment', 'command'])

/**
 * Parses `flow.ndjson`. Like the journal decoder it never throws and keeps
 * everything before a line cut off by a crash; unlike it, it knows only the
 * flow meter's record kinds.
 */
export function decodeFlow(text: string): { records: FlowRecord[]; truncated: boolean; malformed: number } {
  const records: FlowRecord[] = []
  let malformed = 0
  const lines = text.split('\n')
  const truncated = text.length > 0 && lines[lines.length - 1] !== ''
  for (const line of lines.slice(0, -1)) {
    if (line === '') continue
    try {
      const value = JSON.parse(line) as { type?: unknown }
      if (typeof value === 'object' && value !== null && FLOW_TYPES.has(value.type as string)) {
        records.push(value as FlowRecord)
      } else {
        malformed += 1
      }
    } catch {
      malformed += 1
    }
  }
  return { records, truncated, malformed }
}
