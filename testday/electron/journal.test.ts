import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalWriter, readJournalFile } from './journal'
import { JOURNAL_VERSION, isClosed, recordsToSession, type JournalRecord } from '../src/model/journal'

const header: JournalRecord = {
  type: 'header',
  v: JOURNAL_VERSION,
  id: 'session_1',
  startedAt: 1_760_000_000_000,
  protocolId: 'protocol_1',
  protocolName: 'Ramp',
  sport: 'bike',
  athlete: { name: 'Athlete', massKg: 75, ftpWatts: 300 },
}

const sample = (t: number): JournalRecord => ({
  type: 'sample',
  t,
  stepIndex: 0,
  phase: 'work',
  power: 200,
})

describe('JournalWriter', () => {
  let dir = ''
  let path = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'testday-journal-'))
    path = join(dir, 'sessions', 'session_1', 'journal.ndjson')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the session directory and writes readable records', () => {
    const writer = new JournalWriter(path)
    writer.append(header)
    writer.append(sample(1))
    writer.close()

    const { records, truncated, malformed } = readJournalFile(path)

    expect(truncated).toBe(false)
    expect(malformed).toBe(0)
    expect(records).toEqual([header, sample(1)])
  })

  it('makes each record durable before returning', () => {
    const writer = new JournalWriter(path)
    writer.append(header)
    // Nothing has been closed or flushed by hand: if append did not fsync, the
    // file on disk would still be empty at this point.
    expect(statSync(path).size).toBeGreaterThan(0)
    expect(readJournalFile(path).records).toEqual([header])
    writer.close()
  })

  it('appends rather than truncating when a journal is reopened', () => {
    const first = new JournalWriter(path)
    first.append(header)
    first.append(sample(1))
    first.close()

    const second = new JournalWriter(path)
    second.append(sample(2))
    second.close()

    expect(readJournalFile(path).records).toEqual([header, sample(1), sample(2)])
  })

  it('recovers every complete record from a journal cut mid-write', () => {
    const writer = new JournalWriter(path)
    writer.append(header)
    for (let t = 1; t <= 20; t++) writer.append(sample(t))
    writer.close()

    // Simulate `kill -9` landing in the middle of the final write.
    const size = statSync(path).size
    truncateSync(path, size - 15)

    const { records, truncated } = readJournalFile(path)

    expect(truncated).toBe(true)
    expect(isClosed(records)).toBe(false)
    const session = recordsToSession(records)
    expect(session?.samples).toHaveLength(19)
    expect(session?.samples.at(-1)?.t).toBe(19)
  })

  it('treats a missing journal as empty rather than throwing', () => {
    expect(readJournalFile(join(dir, 'nope', 'journal.ndjson'))).toEqual({
      records: [],
      truncated: false,
      malformed: 0,
    })
  })

  it('refuses to write after close instead of failing silently', () => {
    const writer = new JournalWriter(path)
    writer.append(header)
    writer.close()

    expect(() => writer.append(sample(1))).toThrow(/closed/)
  })

  it('writes a batch in one flush for the migration importer', () => {
    const writer = new JournalWriter(path)
    writer.appendAll([header, sample(1), sample(2)])
    writer.close()

    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(3)
    expect(readJournalFile(path).records).toEqual([header, sample(1), sample(2)])
  })
})
