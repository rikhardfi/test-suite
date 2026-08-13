import { deleteSession, listSessions, loadSession, saveSession } from './storage'
import {
  JOURNAL_VERSION,
  summarise,
  type JournalEventKind,
  type JournalHeader,
  type SessionSummary,
} from './journal'
import type { LactateEntry, Sample, SessionRecord } from './session'
import type { FinishResult, Recorder, RecorderStatus } from './recorder'

const AUTOSAVE_MS = 15000

/**
 * Browser recording, kept so the app still runs anywhere for a demo or a
 * rehearsal with the simulator.
 *
 * This is the weaker backend and says so: a browser gives no way to append to a
 * file, so the whole record is rewritten on a timer and a crash costs whatever
 * happened since the last one. Anything with an athlete on it should be run on
 * the desktop build.
 */
export function createIdbRecorder(): Recorder {
  const listeners = new Set<(status: RecorderStatus) => void>()
  let header: JournalHeader | null = null
  let samples: Sample[] = []
  let lactate: LactateEntry[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let lastDurableAt: number | null = null
  let error: string | null = null

  const emit = () => {
    const status: RecorderStatus = {
      recording: header !== null,
      sampleCount: samples.length,
      lastDurableAt,
      bytes: 0,
      error,
    }
    for (const listener of listeners) listener(status)
  }

  const toRecord = (endedAt?: number): SessionRecord | null => {
    if (!header) return null
    return {
      id: header.id,
      protocolId: header.protocolId,
      protocolName: header.protocolName,
      sport: header.sport,
      athlete: header.athlete,
      startedAt: header.startedAt,
      endedAt,
      samples,
      lactate,
    }
  }

  const persist = async (endedAt?: number): Promise<void> => {
    const record = toRecord(endedAt)
    if (!record || record.samples.length === 0) return
    try {
      await saveSession(record)
      lastDurableAt = Date.now()
      error = null
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    emit()
  }

  return {
    kind: 'indexeddb',
    durability: `Saved to this browser every ${AUTOSAVE_MS / 1000} s. Use the desktop app for real tests.`,

    async begin(next: JournalHeader) {
      header = next
      samples = []
      lactate = []
      error = null
      if (timer) clearInterval(timer)
      timer = setInterval(() => void persist(), AUTOSAVE_MS)
      emit()
    },

    sample(sample: Sample) {
      samples.push(sample)
    },

    lactate(entry: LactateEntry) {
      const existing = lactate.findIndex((l) => l.stepIndex === entry.stepIndex)
      if (existing >= 0) lactate[existing] = entry
      else lactate.push(entry)
    },

    event(_kind: JournalEventKind) {
      // Nothing to append to. Events exist for the journal's benefit.
    },

    async finish(endedAt: number): Promise<FinishResult> {
      if (timer) clearInterval(timer)
      timer = null
      await persist(endedAt)
      const count = samples.length
      header = null
      emit()
      return {
        copies: count > 0 && !error ? 1 : 0,
        bytes: 0,
        detail: "Saved in this browser's local database. Export it to keep it.",
        error: error ?? undefined,
      }
    },

    async list(): Promise<SessionSummary[]> {
      const sessions = await listSessions()
      return sessions.map(summariseRecord)
    },

    read: (id) => loadSession(id).then((s) => s ?? null),

    async discard(id: string) {
      await deleteSession(id)
      return true
    },

    async unclosed(): Promise<SessionSummary[]> {
      const sessions = await listSessions()
      return sessions.filter((s) => s.endedAt === undefined).map(summariseRecord)
    },

    async resume(id: string) {
      const session = await loadSession(id)
      if (!session) return null
      header = {
        type: 'header',
        v: JOURNAL_VERSION,
        id: session.id,
        startedAt: session.startedAt,
        protocolId: session.protocolId,
        protocolName: session.protocolName,
        sport: session.sport,
        athlete: session.athlete,
      }
      samples = [...session.samples]
      lactate = [...session.lactate]
      if (timer) clearInterval(timer)
      timer = setInterval(() => void persist(), AUTOSAVE_MS)
      emit()
      return { session, resumeFromS: samples.at(-1)?.t ?? null }
    },

    async amendLactate(sessionId: string, entry: LactateEntry) {
      const session = await loadSession(sessionId)
      if (!session) return null
      const existing = session.lactate.findIndex((l) => l.stepIndex === entry.stepIndex)
      if (existing >= 0) session.lactate[existing] = entry
      else session.lactate.push(entry)
      await saveSession(session)
      return session
    },

    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Reuses the journal summariser so both backends describe a session the same way. */
function summariseRecord(session: SessionRecord): SessionSummary {
  const summary = summarise([
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
  ])!
  return {
    ...summary,
    endedAt: session.endedAt,
    sampleCount: session.samples.length,
    lactateCount: new Set(session.lactate.map((l) => l.stepIndex)).size,
    closed: session.endedAt !== undefined,
  }
}
