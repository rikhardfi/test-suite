import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JOURNAL_VERSION,
  decodeJournal,
  encodeRecords,
  isClosed,
  lastSampleTime,
  recordsToSession,
  sessionToRecords,
  summarise,
  type JournalRecord,
} from './journal'
import { TestRunner } from './session'
import { DEFAULT_ATHLETE, buildStepTest, makeProtocol } from './protocol'

const header = (): JournalRecord => ({
  type: 'header',
  v: JOURNAL_VERSION,
  id: 'session_1',
  startedAt: 1_760_000_000_000,
  protocolId: 'protocol_1',
  protocolName: '8 min lactate step test',
  sport: 'bike',
  athlete: DEFAULT_ATHLETE,
})

const sample = (t: number): JournalRecord => ({
  type: 'sample',
  t,
  stepIndex: 0,
  phase: 'work',
  power: 200 + t,
  heartRate: 140,
})

describe('journal encoding', () => {
  it('round-trips every record type', () => {
    const records: JournalRecord[] = [
      header(),
      sample(1),
      sample(2),
      { type: 'lactate', stepIndex: 0, mmol: 2.4, rpe: 14, at: 1_760_000_100_000 },
      { type: 'event', kind: 'pause', at: 1_760_000_200_000, data: { stepIndex: 1 } },
      { type: 'closed', endedAt: 1_760_000_300_000, sampleCount: 2 },
    ]

    const decoded = decodeJournal(encodeRecords(records))

    expect(decoded.records).toEqual(records)
    expect(decoded.truncated).toBe(false)
    expect(decoded.malformed).toBe(0)
  })

  it('treats an empty file as an empty journal', () => {
    expect(decodeJournal('')).toEqual({ records: [], truncated: false, malformed: 0 })
  })
})

describe('journal damage', () => {
  it('discards a truncated final line and keeps everything before it', () => {
    // Exactly what a `kill -9` part-way through a write leaves behind.
    const whole = encodeRecords([header(), sample(1), sample(2)])
    const cut = whole.slice(0, whole.length - 12)

    const decoded = decodeJournal(cut)

    expect(decoded.truncated).toBe(true)
    expect(decoded.malformed).toBe(0)
    expect(decoded.records).toEqual([header(), sample(1)])
  })

  it('survives a corrupt line in the middle without losing the rest', () => {
    const text = `${encodeRecords([header()])}{"type":"sample",BROKEN\n${encodeRecords([sample(2)])}`

    const decoded = decodeJournal(text)

    expect(decoded.malformed).toBe(1)
    expect(decoded.truncated).toBe(false)
    expect(decoded.records).toEqual([header(), sample(2)])
  })

  it('ignores complete JSON that is not a journal record', () => {
    const text = `${encodeRecords([header()])}{"hello":"world"}\n`

    const decoded = decodeJournal(text)

    expect(decoded.malformed).toBe(1)
    expect(decoded.records).toEqual([header()])
  })
})

describe('session state', () => {
  it('reports an interrupted session as not closed', () => {
    const { records } = decodeJournal(encodeRecords([header(), sample(1)]))
    expect(isClosed(records)).toBe(false)
  })

  it('reports a finished session as closed', () => {
    const { records } = decodeJournal(
      encodeRecords([header(), sample(1), { type: 'closed', endedAt: 1, sampleCount: 1 }]),
    )
    expect(isClosed(records)).toBe(true)
  })

  it('reports a reopened session as open again', () => {
    const { records } = decodeJournal(
      encodeRecords([
        header(),
        sample(1),
        { type: 'closed', endedAt: 10, sampleCount: 1 },
        { type: 'reopened', at: 20 },
      ]),
    )
    expect(isClosed(records)).toBe(false)
  })

  it('reports a session closed again after being reopened as closed', () => {
    const { records } = decodeJournal(
      encodeRecords([
        header(),
        { type: 'closed', endedAt: 10, sampleCount: 1 },
        { type: 'reopened', at: 20 },
        sample(2),
        { type: 'closed', endedAt: 30, sampleCount: 2 },
      ]),
    )
    // The last lifecycle record wins; the earlier ones stay in the file.
    expect(isClosed(records)).toBe(true)
  })

  it('clears the end time when a finished session is reopened', () => {
    const session = recordsToSession([
      header(),
      sample(1),
      { type: 'closed', endedAt: 10, sampleCount: 1 },
      { type: 'reopened', at: 20 },
      sample(2),
    ])
    expect(session?.endedAt).toBeUndefined()
    expect(session?.samples.map((s) => s.t)).toEqual([1, 2])
  })

  it('restores the end time when the reopened session is closed again', () => {
    const session = recordsToSession([
      header(),
      { type: 'closed', endedAt: 10, sampleCount: 1 },
      { type: 'reopened', at: 20 },
      { type: 'closed', endedAt: 30, sampleCount: 2 },
    ])
    expect(session?.endedAt).toBe(30)
  })

  it('summarises a reopened session as not closed', () => {
    const summary = summarise([
      header(),
      sample(1),
      { type: 'closed', endedAt: 10, sampleCount: 1 },
      { type: 'reopened', at: 20 },
    ])
    expect(summary?.closed).toBe(false)
    expect(summary?.endedAt).toBeUndefined()
  })

  it('finds the last sample time for seeding a resume', () => {
    expect(lastSampleTime([header(), sample(1), sample(7)])).toBe(7)
    expect(lastSampleTime([header()])).toBeNull()
  })
})

describe('reconstruction', () => {
  it('rebuilds a session record without a header only as null', () => {
    expect(recordsToSession([sample(1)])).toBeNull()
  })

  it('keeps the last lactate value entered for a step', () => {
    const session = recordsToSession([
      header(),
      { type: 'lactate', stepIndex: 2, mmol: 2.0, at: 1 },
      { type: 'lactate', stepIndex: 2, mmol: 2.6, at: 2 },
    ])

    expect(session?.lactate).toEqual([{ stepIndex: 2, mmol: 2.6, at: 2 }])
  })

  it('drops a lactate value the operator cleared', () => {
    const session = recordsToSession([
      header(),
      { type: 'lactate', stepIndex: 1, mmol: 2.4, at: 1 },
      { type: 'lactate', stepIndex: 2, mmol: 3.1, at: 2 },
      { type: 'lactate', stepIndex: 1, mmol: 0, at: 3, removed: true },
    ])

    // The withdrawal is still in the journal; it just does not survive into the
    // record the analysis runs on.
    expect(session?.lactate).toEqual([{ stepIndex: 2, mmol: 3.1, at: 2 }])
  })

  it('does not count a cleared value in the summary', () => {
    const summary = summarise([
      header(),
      { type: 'lactate', stepIndex: 1, mmol: 2.4, at: 1 },
      { type: 'lactate', stepIndex: 1, mmol: 0, at: 2, removed: true },
    ])

    expect(summary?.lactateCount).toBe(0)
  })

  it('restores a value entered again after being cleared', () => {
    const session = recordsToSession([
      header(),
      { type: 'lactate', stepIndex: 1, mmol: 2.4, at: 1 },
      { type: 'lactate', stepIndex: 1, mmol: 0, at: 2, removed: true },
      { type: 'lactate', stepIndex: 1, mmol: 2.6, at: 3 },
    ])

    expect(session?.lactate).toEqual([{ stepIndex: 1, mmol: 2.6, at: 3 }])
  })

  it('round-trips an existing session record, for the IndexedDB migration', () => {
    const original = recordsToSession([
      header(),
      sample(1),
      sample(2),
      { type: 'lactate', stepIndex: 0, mmol: 2.4, at: 5 },
      { type: 'closed', endedAt: 9, sampleCount: 2 },
    ])
    expect(original).not.toBeNull()

    const rebuilt = recordsToSession(sessionToRecords(original!))

    expect(rebuilt).toEqual(original)
  })

  it('summarises without walking the samples twice', () => {
    const summary = summarise([
      header(),
      sample(1),
      sample(2),
      { type: 'lactate', stepIndex: 0, mmol: 2.4, at: 5 },
      { type: 'lactate', stepIndex: 0, mmol: 2.5, at: 6 },
      { type: 'closed', endedAt: 9, sampleCount: 2 },
    ])

    expect(summary).toMatchObject({
      id: 'session_1',
      protocolName: '8 min lactate step test',
      sampleCount: 2,
      lactateCount: 1,
      closed: true,
      endedAt: 9,
    })
  })
})

/**
 * The load-bearing test: a session rebuilt from its journal must be identical to
 * the one the runner held in memory. If these ever diverge, every analysis in
 * the app is being run on something other than what was recorded.
 */
describe('journal against the runner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reconstructs exactly what TestRunner.toRecord produced', async () => {
    const protocol = makeProtocol(
      'Step test',
      'bike',
      buildStepTest({
        startWatts: 200,
        stepWatts: 20,
        stepDurationS: 60,
        stepCount: 2,
        sampleBreakS: 30,
      }),
    )
    const athlete = { ...DEFAULT_ATHLETE, ftpWatts: 300 }
    const runner = new TestRunner({
      protocol,
      athlete,
      readMetrics: () => ({ power: 210, heartRate: 150, cadence: 90 }),
    })

    runner.start()
    for (let i = 0; i < 100 * 5; i++) await vi.advanceTimersByTimeAsync(200)
    runner.recordLactate({ stepIndex: 0, mmol: 2.4, rpe: 14 })
    runner.finish()

    const inMemory = runner.toRecord('session_1')

    // Build the journal the way the app will: header first, then every sample
    // and lactate entry as it happened, then the close record.
    const records: JournalRecord[] = [
      {
        type: 'header',
        v: JOURNAL_VERSION,
        id: inMemory.id,
        startedAt: inMemory.startedAt,
        protocolId: inMemory.protocolId,
        protocolName: inMemory.protocolName,
        sport: inMemory.sport,
        athlete: inMemory.athlete,
      },
      ...inMemory.samples.map((s) => ({ type: 'sample' as const, ...s })),
      ...inMemory.lactate.map((l) => ({ type: 'lactate' as const, ...l })),
      { type: 'closed', endedAt: inMemory.endedAt!, sampleCount: inMemory.samples.length },
    ]

    const { records: decoded, truncated } = decodeJournal(encodeRecords(records))
    const fromJournal = recordsToSession(decoded)

    expect(truncated).toBe(false)
    expect(fromJournal).toEqual(inMemory)
    expect(fromJournal!.samples.length).toBeGreaterThan(90)
  })
})
