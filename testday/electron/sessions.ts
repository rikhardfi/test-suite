import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { JournalWriter, readJournalFile } from './journal'
import {
  isClosed,
  lastSampleTime,
  recordsToSession,
  sessionToRecords,
  summarise,
  type JournalHeader,
  type JournalRecord,
  type SessionSummary,
} from '../src/model/journal'
import type { SessionRecord } from '../src/model/session'

export const JOURNAL_FILE = 'journal.ndjson'
export const META_FILE = 'meta.json'

/** Result of copying a closed session somewhere else, with proof it arrived. */
export interface MirrorResult {
  ok: boolean
  target: string
  bytes: number
  sha256: string
  error?: string
}

export interface OpenSession {
  id: string
  dir: string
  writer: JournalWriter
  sampleCount: number
}

/**
 * Sessions on disk, one directory each, under a root the operator can see in
 * Finder. Directory names lead with the date so the folder sorts usefully and
 * a session can be identified without opening anything.
 */
export function sessionDirName(startedAt: number, id: string): string {
  const d = new Date(startedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`
  return `${stamp}_${id}`
}

export class SessionStore {
  readonly root: string
  readonly sessionsDir: string
  /** Removed sessions are moved here, never unlinked. */
  readonly discardedDir: string

  constructor(root: string) {
    this.root = root
    this.sessionsDir = join(root, 'sessions')
    this.discardedDir = join(root, 'discarded')
    mkdirSync(this.sessionsDir, { recursive: true })
  }

  private dirNames(): string[] {
    try {
      return readdirSync(this.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** Locates a session directory by id, whatever date prefix it carries. */
  dirFor(id: string): string | null {
    const match = this.dirNames().find((name) => name === id || name.endsWith(`_${id}`))
    return match ? join(this.sessionsDir, match) : null
  }

  journalPath(dir: string): string {
    return join(dir, JOURNAL_FILE)
  }

  /**
   * Starts a new session: creates its directory and commits the header to disk
   * before returning, so a session that exists at all is always readable.
   */
  begin(header: JournalHeader): OpenSession {
    const dir = join(this.sessionsDir, sessionDirName(header.startedAt, header.id))
    mkdirSync(dir, { recursive: true })
    const writer = new JournalWriter(this.journalPath(dir))
    writer.append(header)
    this.writeMeta(dir, { ...emptySummary(header), closed: false })
    return { id: header.id, dir, writer, sampleCount: 0 }
  }

  /** Reopens an interrupted session in append mode, keeping what is on disk. */
  reopen(id: string): { open: OpenSession; records: JournalRecord[] } | null {
    const dir = this.dirFor(id)
    if (!dir) return null
    const { records } = readJournalFile(this.journalPath(dir))
    if (records.length === 0) return null
    const writer = new JournalWriter(this.journalPath(dir))
    const sampleCount = records.filter((r) => r.type === 'sample').length
    return { open: { id, dir, writer, sampleCount }, records }
  }

  /**
   * Writes an already-finished session out as a journal. Used once, to move
   * recordings made in the browser onto disk. An id that already exists is left
   * alone rather than overwritten.
   */
  importSession(session: SessionRecord): boolean {
    if (this.dirFor(session.id)) return false
    const records = sessionToRecords(session)
    const header = records[0] as JournalHeader
    const dir = join(this.sessionsDir, sessionDirName(header.startedAt, header.id))
    mkdirSync(dir, { recursive: true })
    const writer = new JournalWriter(this.journalPath(dir))
    try {
      writer.appendAll(records)
    } finally {
      writer.close()
    }
    this.refreshMeta(dir)
    return true
  }

  list(): SessionSummary[] {
    const out: SessionSummary[] = []
    for (const name of this.dirNames()) {
      const dir = join(this.sessionsDir, name)
      const summary = this.readMeta(dir) ?? this.summariseFromJournal(dir)
      if (summary) out.push(summary)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Sessions whose journal has no close record, so they were interrupted. */
  unclosed(): SessionSummary[] {
    return this.list().filter((summary) => !summary.closed)
  }

  read(id: string): SessionRecord | null {
    const dir = this.dirFor(id)
    if (!dir) return null
    const { records } = readJournalFile(this.journalPath(dir))
    return recordsToSession(records)
  }

  /** Last sample time on disk, used to seed a resumed runner. */
  resumePoint(id: string): number | null {
    const dir = this.dirFor(id)
    if (!dir) return null
    return lastSampleTime(readJournalFile(this.journalPath(dir)).records)
  }

  /**
   * Moves a session out of the list. Nothing is unlinked, because a mistaken
   * click during a test day must not be the thing that loses a recording.
   */
  discard(id: string): boolean {
    const dir = this.dirFor(id)
    if (!dir) return false
    mkdirSync(this.discardedDir, { recursive: true })
    const target = join(this.discardedDir, `${Date.now()}_${id}`)
    renameSync(dir, target)
    return true
  }

  /** Refreshes the cached summary after the journal changed. */
  refreshMeta(dir: string): SessionSummary | null {
    const summary = this.summariseFromJournal(dir)
    if (summary) this.writeMeta(dir, summary)
    return summary
  }

  private summariseFromJournal(dir: string): SessionSummary | null {
    try {
      const { records } = readJournalFile(this.journalPath(dir))
      return summarise(records)
    } catch {
      return null
    }
  }

  private readMeta(dir: string): SessionSummary | null {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as SessionSummary
      // A cached summary claiming the session is still open cannot be trusted:
      // the process may have died before it was refreshed. Re-read the journal.
      if (!parsed.closed) return this.summariseFromJournal(dir)
      return parsed
    } catch {
      return null
    }
  }

  /** Written temp-then-rename, so a crash never leaves half a summary behind. */
  private writeMeta(dir: string, summary: SessionSummary): void {
    const target = join(dir, META_FILE)
    const temp = `${target}.tmp`
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, `${JSON.stringify(summary, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  }

  /**
   * Copies a closed session elsewhere and proves it arrived intact. Verification
   * re-reads the destination from disk rather than trusting the write, because
   * an unverified copy is not a second copy.
   */
  mirror(id: string, mirrorRoot: string): MirrorResult {
    const dir = this.dirFor(id)
    const target = join(mirrorRoot, dir ? dir.split('/').pop()! : id)
    if (!dir) {
      return { ok: false, target, bytes: 0, sha256: '', error: `No session directory for ${id}` }
    }

    try {
      const sourceJournal = this.journalPath(dir)
      const source = readFileSync(sourceJournal)

      mkdirSync(target, { recursive: true })
      copyDurable(source, join(target, JOURNAL_FILE))
      const metaPath = join(dir, META_FILE)
      if (existsSync(metaPath)) copyDurable(readFileSync(metaPath), join(target, META_FILE))

      const verdict = verifyCopy(source, join(target, JOURNAL_FILE))
      return { ...verdict, target }
    } catch (error) {
      return {
        ok: false,
        target,
        bytes: 0,
        sha256: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Size on disk of a session's journal, for the "it is really there" display. */
  bytesOnDisk(id: string): number {
    const dir = this.dirFor(id)
    if (!dir) return 0
    try {
      return statSync(this.journalPath(dir)).size
    } catch {
      return 0
    }
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * Re-reads a copy from disk and compares it with the bytes it was made from.
 * Size is checked before the digest so a truncated copy reports the useful
 * number rather than two hex strings the operator cannot act on.
 */
export function verifyCopy(source: Buffer, copyPath: string): Omit<MirrorResult, 'target'> {
  let landed: Buffer
  try {
    landed = readFileSync(copyPath)
  } catch (error) {
    return {
      ok: false,
      bytes: 0,
      sha256: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (landed.byteLength !== source.byteLength) {
    return {
      ok: false,
      bytes: landed.byteLength,
      sha256: '',
      error: `Copy is ${landed.byteLength} bytes, source is ${source.byteLength} bytes`,
    }
  }

  const digest = sha256(landed)
  if (digest !== sha256(source)) {
    return { ok: false, bytes: landed.byteLength, sha256: digest, error: 'Checksum mismatch' }
  }

  return { ok: true, bytes: landed.byteLength, sha256: digest }
}

/** Writes to a temporary name, fsyncs, then renames into place. */
function copyDurable(data: Buffer, target: string): void {
  const temp = `${target}.tmp`
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, target)
}

function emptySummary(header: JournalHeader): SessionSummary {
  return {
    id: header.id,
    startedAt: header.startedAt,
    protocolName: header.protocolName,
    sport: header.sport,
    athleteName: header.athlete?.name,
    sampleCount: 0,
    lactateCount: 0,
    closed: false,
  }
}

export { isClosed }
