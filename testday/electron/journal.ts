import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  decodeJournal,
  encodeRecord,
  type DecodedJournal,
  type JournalRecord,
} from '../src/model/journal'

/**
 * The file half of the recording journal. All parsing lives in
 * `src/model/journal.ts`; this is only the part that touches the disk.
 *
 * On durability: every append is followed by `fsync`, which is what makes a
 * record survive the app dying, being killed, or the OS panicking. It is not a
 * defence against sudden power loss, because macOS `fsync` does not flush the
 * drive's own write cache (that needs `F_FULLFSYNC`, which Node does not
 * expose). Run test days on mains power. This limit is stated in the README
 * rather than quietly assumed away.
 */
export class JournalWriter {
  readonly path: string
  private fd: number | null = null
  private written = 0
  private lastWriteAt = 0

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    // Append mode, so reopening an interrupted session continues its journal
    // rather than starting a second one.
    this.fd = openSync(path, 'a')
  }

  get isOpen(): boolean {
    return this.fd !== null
  }

  /** Records appended by this writer, not counting any it reopened. */
  get recordsWritten(): number {
    return this.written
  }

  get lastDurableAt(): number {
    return this.lastWriteAt
  }

  /**
   * Appends one record and does not return until it is on disk. Throws on
   * failure, so a caller can never mistake a failed write for a successful one.
   */
  append(record: JournalRecord): void {
    if (this.fd === null) throw new Error(`Journal is closed: ${this.path}`)
    writeSync(this.fd, encodeRecord(record))
    fsyncSync(this.fd)
    this.written += 1
    this.lastWriteAt = Date.now()
  }

  appendAll(records: readonly JournalRecord[]): void {
    if (this.fd === null) throw new Error(`Journal is closed: ${this.path}`)
    if (records.length === 0) return
    // One fsync for the batch: used by the migration importer, never by the
    // live recorder, where each sample gets its own.
    let text = ''
    for (const record of records) text += encodeRecord(record)
    writeSync(this.fd, text)
    fsyncSync(this.fd)
    this.written += records.length
    this.lastWriteAt = Date.now()
  }

  close(): void {
    if (this.fd === null) return
    try {
      fsyncSync(this.fd)
    } finally {
      closeSync(this.fd)
      this.fd = null
    }
  }
}

/** Reads a journal from disk. A missing file is an empty journal, not an error. */
export function readJournalFile(path: string): DecodedJournal {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], truncated: false, malformed: 0 }
    }
    throw error
  }
  return decodeJournal(text)
}
