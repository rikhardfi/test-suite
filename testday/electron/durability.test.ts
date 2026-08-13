import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJournalFile } from './journal'
import { isClosed, rawFromRecords, recordsToSession } from '../src/model/journal'

/**
 * The claim this whole design rests on is that a recording survives the process
 * dying. Truncating a file by hand does not test that: it tests the reader.
 *
 * So this spawns a real child process that records at speed, kills it with
 * SIGKILL (which no handler can intercept and no buffer can be flushed after),
 * and checks that every sample the child reported having written is on disk.
 */

// The child is written to a temp directory, so it refers to the journal module
// by absolute path rather than relative to a location it does not share.
const JOURNAL_MODULE = join(dirname(fileURLToPath(import.meta.url)), 'journal.ts')

const CHILD_SOURCE = `
import { JournalWriter } from ${JSON.stringify(JOURNAL_MODULE)}

const path = process.argv[2]
const writer = new JournalWriter(path)

writer.append({
  type: 'header',
  v: 1,
  id: 'session_kill',
  startedAt: 1760000000000,
  protocolId: 'p',
  protocolName: 'Kill test',
  sport: 'bike',
  athlete: { name: 'Athlete', massKg: 75, ftpWatts: 300 },
})

let t = 0
setInterval(() => {
  // The native-rate stream is written between samples, at four times the rate,
  // which is what a real trainer and strap produce. Interleaving them here is
  // the point: the two streams share one append-only file, and a kill has to
  // leave both readable rather than only the one the test happens to check.
  for (let i = 1; i <= 4; i++) {
    writer.append({
      type: 'raw',
      d: 'trainer',
      at: 1760000000000 + t * 1000 + i * 250,
      t: t + i / 4,
      v: { power: 200 + t, cadence: 90 },
    })
  }
  t += 1
  writer.append({ type: 'sample', t, stepIndex: 0, phase: 'work', power: 200 + t })
  writer.append({ type: 'rr', at: 1760000000000 + t * 1000, t, ms: [800 + t] })
  // Only reported once the append has returned, so the parent is told about a
  // sample strictly after it has been fsynced.
  process.stdout.write(\`wrote \${t}\\n\`)
}, 2)
`

let workDir = ''
let childScript = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'testday-kill-'))
  const entry = join(workDir, 'child.ts')
  writeFileSync(entry, CHILD_SOURCE)
  childScript = join(workDir, 'child.cjs')
  // Bundled so the child runs the same journal code the app does, with no
  // TypeScript loader in the way.
  await build({
    entryPoints: [entry],
    outfile: childScript,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: process.cwd(),
    logLevel: 'silent',
  })
}, 30000)

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('surviving a killed process', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'testday-kill-run-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps every sample the recorder acknowledged before SIGKILL', async () => {
    const journal = join(dir, 'journal.ndjson')
    const child = spawn(process.execPath, [childScript, journal], { stdio: ['ignore', 'pipe', 'inherit'] })

    const acknowledged = await new Promise<number>((resolve, reject) => {
      let last = 0
      const timeout = setTimeout(() => reject(new Error('child never reported progress')), 10000)
      child.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const match = /^wrote (\d+)$/.exec(line.trim())
          if (match) last = Number(match[1])
        }
        if (last >= 50) {
          clearTimeout(timeout)
          // SIGKILL: no cleanup handler runs, nothing gets a chance to flush.
          child.kill('SIGKILL')
          resolve(last)
        }
      })
      child.on('error', reject)
    })

    await new Promise((resolve) => child.on('exit', resolve))

    const { records, truncated, malformed } = readJournalFile(journal)
    const session = recordsToSession(records)

    expect(malformed).toBe(0)
    expect(session).not.toBeNull()

    const times = session!.samples.map((s) => s.t)

    // The disk may legitimately hold *more* than the parent was told about: the
    // child can fsync a sample and be killed before the parent reads the line
    // announcing it. That direction is safe. What must never happen is the
    // reverse, or a hole in the middle.
    expect(times.length).toBeGreaterThanOrEqual(acknowledged)
    expect(times).toEqual(Array.from({ length: times.length }, (_, i) => i + 1))
    // The high-rate stream has to survive the same kill, and interleaving it
    // with samples must not have corrupted either. Four raw records are written
    // per sample, so anything short of that for the completed iterations means
    // records were lost rather than merely cut at the tail.
    const raw = rawFromRecords(records)
    expect(raw.length).toBeGreaterThanOrEqual(4 * (times.length - 1))
    expect(raw.map((r) => r.t)).toEqual([...raw.map((r) => r.t)].sort((a, b) => a - b))
    expect(raw.every((r) => r.v.power !== undefined)).toBe(true)
    // Beat intervals likewise: one per sample, so a hole here would show as a
    // count that has fallen behind the sample stream.
    expect(session!.rr?.length ?? 0).toBeGreaterThanOrEqual(times.length - 1)

    // And the session is correctly recognised as interrupted, so it will be
    // offered for resume rather than filed as finished.
    expect(isClosed(records)).toBe(false)
    // A tail cut mid-write is expected and harmless; it costs at most the one
    // sample the child had not yet been told was durable.
    expect(typeof truncated).toBe('boolean')
  }, 20000)
})
