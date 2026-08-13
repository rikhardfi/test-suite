import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, sessionDirName, verifyCopy } from './sessions'
import { JOURNAL_VERSION, type JournalHeader, type JournalRecord } from '../src/model/journal'

const STARTED_AT = new Date(2026, 7, 12, 7, 31, 0).getTime()

const header = (id = 'session_1'): JournalHeader => ({
  type: 'header',
  v: JOURNAL_VERSION,
  id,
  startedAt: STARTED_AT,
  protocolId: 'protocol_1',
  protocolName: '8 min lactate step test',
  sport: 'bike',
  athlete: { name: 'Athlete', massKg: 75, ftpWatts: 300 },
})

const sample = (t: number): JournalRecord => ({
  type: 'sample',
  t,
  stepIndex: 0,
  phase: 'work',
  power: 200 + t,
})

describe('SessionStore', () => {
  let root = ''
  let store: SessionStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'testday-store-'))
    store = new SessionStore(join(root, 'testday'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('names directories by date so the folder is readable in Finder', () => {
    expect(sessionDirName(STARTED_AT, 'session_1')).toBe('2026-08-12_07-31_session_1')
  })

  it('commits the header before begin() returns', () => {
    const open = store.begin(header())
    // Deliberately not closing the writer: the header must already be durable.
    expect(existsSync(join(open.dir, 'journal.ndjson'))).toBe(true)
    expect(store.read('session_1')?.protocolName).toBe('8 min lactate step test')
    open.writer.close()
  })

  it('lists sessions newest first', () => {
    const a = store.begin(header('session_a'))
    a.writer.close()
    const b = store.begin({ ...header('session_b'), startedAt: STARTED_AT + 3_600_000 })
    b.writer.close()

    expect(store.list().map((s) => s.id)).toEqual(['session_b', 'session_a'])
  })

  it('reports a session with no close record as unclosed', () => {
    const open = store.begin(header())
    open.writer.append(sample(1))
    open.writer.close()

    expect(store.unclosed().map((s) => s.id)).toEqual(['session_1'])

    const reopened = store.reopen('session_1')!
    reopened.open.writer.append({ type: 'closed', endedAt: STARTED_AT + 1000, sampleCount: 1 })
    reopened.open.writer.close()
    store.refreshMeta(reopened.open.dir)

    expect(store.unclosed()).toEqual([])
  })

  it('does not trust a cached summary that claims a session is still open', () => {
    const open = store.begin(header())
    open.writer.append(sample(1))
    open.writer.append(sample(2))
    open.writer.close()

    // meta.json was written at begin() with a sample count of zero.
    const summary = store.list()[0]
    expect(summary.sampleCount).toBe(2)
  })

  it('reopens an interrupted journal and appends to it', () => {
    const open = store.begin(header())
    open.writer.append(sample(1))
    open.writer.close()

    const reopened = store.reopen('session_1')!
    expect(reopened.open.sampleCount).toBe(1)
    reopened.open.writer.append(sample(2))
    reopened.open.writer.close()

    expect(store.read('session_1')?.samples.map((s) => s.t)).toEqual([1, 2])
    expect(store.resumePoint('session_1')).toBe(2)
  })

  it('reopens a finished session and records into it again', () => {
    const open = store.begin(header())
    open.writer.append(sample(1))
    open.writer.append({ type: 'closed', endedAt: STARTED_AT + 1000, sampleCount: 1 })
    open.writer.close()
    store.refreshMeta(open.dir)
    expect(store.list()[0].closed).toBe(true)

    // What the resume handler does for an already-closed journal.
    const again = store.reopen('session_1')!
    again.open.writer.append({ type: 'reopened', at: STARTED_AT + 2000 })
    again.open.writer.append(sample(2))
    again.open.writer.close()
    store.refreshMeta(again.open.dir)

    const summary = store.list()[0]
    expect(summary.closed).toBe(false)
    expect(summary.sampleCount).toBe(2)
    expect(summary.endedAt).toBeUndefined()
    // The original close record is still in the file: nothing was rewritten.
    expect(store.read('session_1')?.samples.map((s) => s.t)).toEqual([1, 2])
  })

  it('recovers a session whose journal was cut mid-write', () => {
    const open = store.begin(header())
    for (let t = 1; t <= 10; t++) open.writer.append(sample(t))
    open.writer.close()

    truncateSync(join(open.dir, 'journal.ndjson'), store.bytesOnDisk('session_1') - 10)

    expect(store.read('session_1')?.samples).toHaveLength(9)
    expect(store.unclosed().map((s) => s.id)).toEqual(['session_1'])
  })

  it('moves a discarded session aside instead of unlinking it', () => {
    const open = store.begin(header())
    open.writer.append(sample(1))
    open.writer.close()

    expect(store.discard('session_1')).toBe(true)
    expect(store.list()).toEqual([])
    expect(readdirSync(store.discardedDir)).toHaveLength(1)
  })
})

describe('mirroring', () => {
  let root = ''
  let store: SessionStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'testday-mirror-'))
    store = new SessionStore(join(root, 'testday'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies a closed session and proves it arrived', () => {
    const open = store.begin(header())
    for (let t = 1; t <= 5; t++) open.writer.append(sample(t))
    open.writer.append({ type: 'closed', endedAt: STARTED_AT + 5000, sampleCount: 5 })
    open.writer.close()
    store.refreshMeta(open.dir)

    const result = store.mirror('session_1', join(root, 'OneDrive'))

    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(store.bytesOnDisk('session_1'))
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(result.target, 'journal.ndjson'))).toBe(true)
    expect(existsSync(join(result.target, 'meta.json'))).toBe(true)
  })

  it('reports a missing session rather than claiming a copy was made', () => {
    const result = store.mirror('nope', join(root, 'OneDrive'))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No session directory/)
  })

  it('catches a copy that is the wrong length', () => {
    const path = join(root, 'copy.ndjson')
    writeFileSync(path, 'short')

    const verdict = verifyCopy(Buffer.from('much longer original'), path)

    expect(verdict.ok).toBe(false)
    expect(verdict.error).toBe('Copy is 5 bytes, source is 20 bytes')
  })

  it('catches a copy of the right length whose content differs', () => {
    const path = join(root, 'copy.ndjson')
    writeFileSync(path, 'aaaaa')

    const verdict = verifyCopy(Buffer.from('bbbbb'), path)

    expect(verdict.ok).toBe(false)
    expect(verdict.error).toBe('Checksum mismatch')
  })

  it('catches a copy that never landed', () => {
    const verdict = verifyCopy(Buffer.from('data'), join(root, 'absent.ndjson'))
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toMatch(/ENOENT/)
  })
})
