import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFlow } from '../../src/model/flow'
import type { JournalEventKind } from '../../src/model/journal'
import { FlowCapture } from './capture'
import { TsiEmulator } from './emulator'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('FlowCapture', () => {
  let dir = ''
  let emulator: TsiEmulator
  let capture: FlowCapture
  let events: { kind: JournalEventKind; data: Record<string, number | string | boolean> }[]
  let port = 0

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'testday-flow-'))
    emulator = new TsiEmulator({ segmentRows: 3000, restartDelayMs: 40, burstMs: 20, flowLMin: 30 })
    port = await emulator.listen()
    events = []
    capture = new FlowCapture({
      pushStatus: () => {},
      journalEvent: (kind, data) => events.push({ kind, data }),
      writeFailed: (message) => {
        throw new Error(message)
      },
      info: () => {},
      // Never the real meter on the USB link, whatever else is plugged in.
      meter: { port, candidates: () => [] },
    })
  })

  afterEach(async () => {
    await capture.shutdown()
    await emulator.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const flowRecords = () => {
    const decoded = decodeFlow(readFileSync(join(dir, 'flow.ndjson'), 'utf8'))
    expect(decoded.malformed).toBe(0)
    return decoded.records
  }

  it('streams without writing until a session is attached, then writes it all', async () => {
    await capture.connect({ host: '127.0.0.1', rateMs: 10 })
    // Not recording: nothing reaches a file, and the journal hears nothing.
    await sleep(300)
    expect(events).toEqual([])

    capture.attach(dir)
    await sleep(1300)
    const zero = await capture.zero()
    expect(zero.ok).toBe(true)
    await sleep(300)
    capture.attach(null)

    const records = flowRecords()
    expect(records[0]).toMatchObject({ type: 'meter', serial: 'EMULATOR01', rateMs: 10 })
    const blocks = records.filter((r) => r.type === 'block')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.type === 'block' && b.f.length === b.tot.length)).toBe(true)
    expect(records.some((r) => r.type === 'segment')).toBe(true)
    expect(records.some((r) => r.type === 'command' && r.command === 'zeroLowPressure')).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(['flowMeter', 'flowZero'])

    // The segment that was still streaming at detach has an anchor on file.
    const lastBlock = blocks.at(-1)!
    const anchored = records.filter((r) => r.type === 'segment' && r.seg === lastBlock.seg)
    expect(anchored.length).toBeGreaterThan(0)

    // Detached: writing stops.
    const count = flowRecords().length
    await sleep(1200)
    expect(flowRecords().length).toBe(count)
  })

  it('refuses a rate change in the middle of a recording', async () => {
    await capture.connect({ host: '127.0.0.1', rateMs: 10 })
    capture.attach(dir)
    await expect(capture.setRate(1)).rejects.toThrow(/cannot change while a session is recording/)
    capture.attach(null)
    const result = await capture.setRate(1)
    expect(result.ok).toBe(true)
  })

  it('refuses a rate the meter does not offer', async () => {
    await expect(capture.connect({ host: '127.0.0.1', rateMs: 7 })).rejects.toThrow(/must be one of/)
  })
})
