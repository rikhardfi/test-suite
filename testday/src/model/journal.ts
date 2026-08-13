import type { Athlete, Protocol } from './protocol'
import type { LactateEntry, Sample, SessionRecord } from './session'

/**
 * The on-disk recording format: one JSON object per line, appended and fsynced
 * as the test runs, never rewritten.
 *
 * Everything here is pure. It holds no Node and no DOM references, so the same
 * encoder and decoder run in the Electron main process, in the renderer, and in
 * tests. The file I/O around it lives in `electron/journal.ts`.
 *
 * Two properties matter more than anything else in this module:
 *
 * 1. A journal truncated mid-write loses the final line and nothing else.
 * 2. A journal without a `closed` record is an interrupted session. That is the
 *    only signal the resume flow needs, so there is no lock file to go stale.
 */

export const JOURNAL_VERSION = 1

/** Sport, protocol and athlete, so a record can be rebuilt from the file alone. */
export interface JournalHeader {
  type: 'header'
  v: number
  id: string
  startedAt: number
  protocolId: string
  protocolName: string
  sport: Protocol['sport']
  athlete: Athlete
}

export type JournalEventKind =
  | 'start'
  | 'pause'
  | 'resume'
  | 'jump'
  | 'intensity'
  | 'resumedFromDisk'

export interface JournalEvent {
  type: 'event'
  kind: JournalEventKind
  at: number
  /** Free-form detail: the step jumped to, the intensity set, and so on. */
  data?: Record<string, number | string | boolean>
}

export interface JournalClose {
  type: 'closed'
  endedAt: number
  sampleCount: number
}

/**
 * Written when a finished session is opened for recording again. The journal is
 * append-only, so a session cannot be un-closed by deleting its close record;
 * the reopening is itself an event, and the last one wins.
 */
export interface JournalReopen {
  type: 'reopened'
  at: number
}

/**
 * Samples and lactate entries are stored flat rather than nested, because the
 * operator reads this file with `tail -f` during a test. Neither `Sample` nor
 * `LactateEntry` has a `type` key, so there is nothing to collide with.
 */
export type JournalRecord =
  | JournalHeader
  | ({ type: 'sample' } & Sample)
  | ({ type: 'lactate' } & LactateEntry)
  | JournalEvent
  | JournalClose
  | JournalReopen

export interface DecodedJournal {
  records: JournalRecord[]
  /**
   * True when the final line was incomplete, which is the expected state of a
   * journal whose process was killed mid-write. The records before it are good.
   */
  truncated: boolean
  /** Complete lines that could not be understood. Should always be zero. */
  malformed: number
}

export const encodeRecord = (record: JournalRecord): string => `${JSON.stringify(record)}\n`

export const encodeRecords = (records: readonly JournalRecord[]): string =>
  records.map(encodeRecord).join('')

/**
 * Parses a whole journal. Never throws: a damaged file has to yield everything
 * that survived, because the alternative is losing a test to one bad byte.
 */
export function decodeJournal(text: string): DecodedJournal {
  const records: JournalRecord[] = []
  let truncated = false
  let malformed = 0

  if (text.length === 0) return { records, truncated, malformed }

  const lines = text.split('\n')
  // A well-formed journal ends with a newline, so the final element is empty.
  // Anything else means the process died part-way through writing that line.
  // Either way the final element is not a complete record, so it is dropped.
  truncated = lines[lines.length - 1] !== ''

  for (const line of lines.slice(0, -1)) {
    if (line === '') continue
    const record = parseRecord(line)
    if (record) records.push(record)
    else malformed += 1
  }

  return { records, truncated, malformed }
}

function parseRecord(line: string): JournalRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  if (
    type !== 'header' &&
    type !== 'sample' &&
    type !== 'lactate' &&
    type !== 'event' &&
    type !== 'closed' &&
    type !== 'reopened'
  ) {
    return null
  }
  return value as JournalRecord
}

export const headerOf = (records: readonly JournalRecord[]): JournalHeader | null =>
  (records.find((r) => r.type === 'header') as JournalHeader | undefined) ?? null

/**
 * Whether the session is finished *as of the end of the journal*.
 *
 * Not "does a close record exist": a session can be finished, reopened and
 * recorded into again, and the file keeps every one of those events. The last
 * lifecycle record is the one that describes the session now.
 */
export function isClosed(records: readonly JournalRecord[]): boolean {
  let closed = false
  for (const record of records) {
    if (record.type === 'closed') closed = true
    else if (record.type === 'reopened') closed = false
  }
  return closed
}

/** Time of the last recorded sample, for seeding a resumed runner. */
export function lastSampleTime(records: readonly JournalRecord[]): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record.type === 'sample') return record.t
  }
  return null
}

/**
 * Rebuilds the record the rest of the app already understands, so every
 * analysis function works on a journal without knowing it came from one.
 * Returns null when there is no header, which means the file is not a session.
 */
export function recordsToSession(records: readonly JournalRecord[]): SessionRecord | null {
  const header = headerOf(records)
  if (!header) return null

  const samples: Sample[] = []
  // Insertion-ordered, so a corrected value keeps the position of the original.
  const lactate = new Map<number, LactateEntry>()
  let endedAt: number | undefined

  for (const record of records) {
    switch (record.type) {
      case 'sample': {
        const { type: _type, ...sample } = record
        samples.push(sample)
        break
      }
      case 'lactate': {
        const { type: _type, ...entry } = record
        // Last write wins, the same way `TestRunner.recordLactate` behaves in
        // memory. A cleared value arrives as a record too, and is dropped below.
        lactate.set(entry.stepIndex, entry)
        break
      }
      case 'closed':
        endedAt = record.endedAt
        break
      case 'reopened':
        // Recording resumed, so the session has no end time again until it is
        // closed a second time.
        endedAt = undefined
        break
      default:
        break
    }
  }

  return {
    id: header.id,
    protocolId: header.protocolId,
    protocolName: header.protocolName,
    sport: header.sport,
    athlete: header.athlete,
    startedAt: header.startedAt,
    endedAt,
    samples,
    lactate: [...lactate.values()].filter((entry) => !entry.removed),
  }
}

/** The reverse, for migrating sessions that were recorded into IndexedDB. */
export function sessionToRecords(session: SessionRecord): JournalRecord[] {
  const records: JournalRecord[] = [
    {
      type: 'header',
      v: JOURNAL_VERSION,
      id: session.id,
      startedAt: session.startedAt,
      protocolId: session.protocolId,
      protocolName: session.protocolName,
      sport: session.sport,
      athlete: session.athlete,
    },
  ]
  for (const sample of session.samples) records.push({ type: 'sample', ...sample })
  for (const entry of session.lactate) records.push({ type: 'lactate', ...entry })
  records.push({
    type: 'closed',
    endedAt: session.endedAt ?? session.startedAt,
    sampleCount: session.samples.length,
  })
  return records
}

/** Cheap summary for the session list, without holding every sample in memory. */
export interface SessionSummary {
  id: string
  startedAt: number
  endedAt?: number
  protocolName: string
  sport: Protocol['sport']
  athleteName?: string
  sampleCount: number
  lactateCount: number
  closed: boolean
}

export function summarise(records: readonly JournalRecord[]): SessionSummary | null {
  const header = headerOf(records)
  if (!header) return null
  let sampleCount = 0
  // Tracks the latest state per step, so a cleared value is not still counted.
  const lactateSteps = new Map<number, boolean>()
  let endedAt: number | undefined
  for (const record of records) {
    if (record.type === 'sample') sampleCount += 1
    else if (record.type === 'lactate') lactateSteps.set(record.stepIndex, !record.removed)
    else if (record.type === 'closed') endedAt = record.endedAt
    else if (record.type === 'reopened') endedAt = undefined
  }
  return {
    id: header.id,
    startedAt: header.startedAt,
    endedAt,
    protocolName: header.protocolName,
    sport: header.sport,
    athleteName: header.athlete?.name,
    sampleCount,
    lactateCount: [...lactateSteps.values()].filter(Boolean).length,
    closed: isClosed(records),
  }
}
