import { JOURNAL_VERSION } from './journal'
import type { JournalEventKind, JournalHeader, SessionSummary } from './journal'
import type { LactateEntry, Sample, SessionRecord } from './session'
import type { Protocol, Athlete } from './protocol'
import type { MetricKey } from '../ble/types'

/**
 * Where a session goes while it is being recorded, and where finished ones are
 * read back from.
 *
 * Two implementations exist. On the desktop, every sample is appended to a file
 * and fsynced as it happens. In a plain browser there is no file to append to,
 * so the IndexedDB backend keeps the old whole-record autosave. The difference
 * is deliberately visible in `durability`, because the interface has to be able
 * to tell the operator which one they are relying on.
 */
export interface Recorder {
  readonly kind: 'file' | 'indexeddb'
  /** Honest description of what survives a crash, shown in the interface. */
  readonly durability: string

  begin(header: JournalHeader): Promise<void>
  sample(sample: Sample): void
  lactate(entry: LactateEntry): void
  event(kind: JournalEventKind, data?: Record<string, number | string | boolean>): void
  /**
   * One decoded notification at its native rate. Fire-and-forget and
   * deliberately cheap: this is the highest-volume call in the app, and it must
   * never be able to delay the 1 Hz sample it sits underneath.
   */
  raw(deviceId: string, t: number, values: Partial<Record<MetricKey, number>>): void
  /** Beat-to-beat intervals, which arrive per beat rather than per second. */
  rr(t: number, intervalsMs: number[]): void
  /** Returns how many verified copies of the recording now exist. */
  finish(endedAt: number): Promise<FinishResult>

  list(): Promise<SessionSummary[]>
  read(id: string): Promise<SessionRecord | null>
  discard(id: string): Promise<boolean>
  /** Sessions whose recording was interrupted, newest first. */
  unclosed(): Promise<SessionSummary[]>
  resume(id: string): Promise<ResumeState | null>
  /**
   * Corrects a lactate value on a session that is already finished. The journal
   * is append-only, so this adds a record rather than rewriting one, and the
   * later value wins on read.
   */
  amendLactate(sessionId: string, entry: LactateEntry): Promise<SessionRecord | null>

  onStatus(listener: (status: RecorderStatus) => void): () => void
}

export interface FinishResult {
  copies: number
  bytes: number
  detail: string
  error?: string
}

export interface ResumeState {
  session: SessionRecord
  resumeFromS: number | null
}

/** What the dashboard's recording pill displays. */
export interface RecorderStatus {
  recording: boolean
  sampleCount: number
  lastDurableAt: number | null
  bytes: number
  error: string | null
}

export const IDLE_STATUS: RecorderStatus = {
  recording: false,
  sampleCount: 0,
  lastDurableAt: null,
  bytes: 0,
  error: null,
}

/** Builds the opening record of a journal from what the app already holds. */
export function headerFor(
  id: string,
  protocol: Protocol,
  athlete: Athlete,
  startedAt: number,
): JournalHeader {
  return {
    type: 'header',
    v: JOURNAL_VERSION,
    id,
    startedAt,
    protocolId: protocol.id,
    protocolName: protocol.name,
    sport: protocol.sport,
    athlete,
  }
}
