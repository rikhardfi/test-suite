import { afterEach, describe, expect, it } from 'vitest'
import type { FlowBlock, FlowCommand, FlowMeterRecord, FlowSegment } from '../../src/model/flow'
import { TsiEmulator, type EmulatorOptions } from './emulator'
import { TsiMeter } from './meter'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(10)
  }
}

interface Rig {
  emulator: TsiEmulator
  meter: TsiMeter
  blocks: FlowBlock[]
  segments: FlowSegment[]
  meters: FlowMeterRecord[]
  commands: FlowCommand[]
}

let rig: Rig | null = null

afterEach(async () => {
  await rig?.meter.stop()
  await rig?.emulator.close()
  rig = null
})

const RATE = 2
const ROWS = 150

async function setup(overrides: Partial<EmulatorOptions> = {}): Promise<Rig> {
  const emulator = new TsiEmulator({
    segmentRows: ROWS,
    restartDelayMs: 40,
    burstMs: 20,
    flowLMin: 60,
    encodeTime: true,
    ...overrides,
  })
  const port = await emulator.listen()
  const r: Rig = { emulator, blocks: [], segments: [], meters: [], commands: [], meter: null as unknown as TsiMeter }
  r.meter = new TsiMeter({
    host: '127.0.0.1',
    port,
    rateMs: RATE,
    segmentMs: ROWS * RATE,
    flushMs: 100,
    reconnectMs: 100,
    candidates: () => [],
    onBlock: (b) => r.blocks.push(b),
    onSegment: (s) => r.segments.push(s),
    onMeter: (m) => r.meters.push(m),
    onCommand: (c) => r.commands.push(c),
  })
  rig = r
  await r.meter.start()
  return r
}

/** Every row of a segment with its true time, which the emulator put in `lp`. */
const rowsOf = (r: Rig, seg: number) =>
  r.blocks
    .filter((b) => b.seg === seg)
    .flatMap((b) => b.lp.map((truth, k) => ({ i: b.i0 + k, truth })))

describe('TsiMeter against the emulator', () => {
  it('stops any stream, reads the meter and sets the rate before streaming', async () => {
    const r = await setup()
    expect(r.emulator.received.slice(0, 7)).toEqual(['BREAK', 'MN', 'SN', 'REV', 'DATE', 'SSR0002', 'RU'])
    expect(r.meters[0]).toMatchObject({ model: '533002', serial: 'EMULATOR01', rateMs: 2, directionSensor: false })
    expect(r.meter.state).toBe('connected')
  })

  it('chains segments without stopping and times every row from its index', async () => {
    const r = await setup()
    await until(() => r.segments.length >= 3)

    // No BREAK after the start: each next stream was queued in time.
    expect(r.emulator.received.filter((c) => c === 'BREAK')).toHaveLength(1)
    expect(r.segments.map((s) => s.start)).toEqual(['first', 'continuous', 'continuous'])

    for (const segment of r.segments.slice(0, 3)) {
      expect(segment.n).toBe(ROWS)
      const rows = rowsOf(r, segment.seg)
      expect(rows.map((row) => row.i)).toEqual([...Array(ROWS).keys()])
      for (const row of rows) {
        const estimate = segment.anchorAt + row.i * segment.dt
        // Delivered in 20 ms bursts; the envelope must take that back out.
        expect(Math.abs(estimate - row.truth)).toBeLessThan(3)
      }
    }
  })

  it('measures the gap between segments and the volume that passed in it', async () => {
    const r = await setup()
    await until(() => r.segments.length >= 3)
    for (const segment of r.segments.slice(1, 3)) {
      const previous = rowsOf(r, segment.seg - 1).at(-1)!.truth
      const first = rowsOf(r, segment.seg)[0].truth
      const trueGapMs = first - previous - RATE
      expect(segment.gapBefore).not.toBeNull()
      expect(Math.abs(segment.gapBefore!.ms - trueGapMs)).toBeLessThan(4)
      expect(Math.abs(segment.gapBefore!.samples - Math.round(trueGapMs / RATE))).toBeLessThanOrEqual(2)
      // 60 L/min is 1 mL/ms; the totalizer has 0.1 mL resolution in the emulator.
      expect(segment.gapBefore!.volumeL! * 1000).toBeCloseTo(trueGapMs, -1)
    }
  })

  it('zeroes and resets between streams, and records both', async () => {
    const r = await setup()
    await until(() => r.segments.length >= 1)
    const zero = await r.meter.zeroLowPressure()
    const reset = await r.meter.resetTotalizer()
    expect(zero).toMatchObject({ command: 'zeroLowPressure', ok: true })
    expect(reset).toMatchObject({ command: 'resetTotalizer', ok: true })
    expect(r.emulator.received).toContain('LPZ')
    expect(r.emulator.received).toContain('TRESET')

    const after = r.segments.length
    await until(() => r.segments.length > after + 1)
    const restarted = r.segments.find((s) => s.start === 'restart' && s.seg > 0)
    expect(restarted).toBeDefined()
    // The segment straight after the reset cannot use the totalizer for its gap.
    const afterReset = r.segments.filter((s) => s.start === 'restart').at(-1)!
    expect(afterReset.gapBefore!.volumeL).toBeNull()
    // And streaming carried on.
    expect(r.meter.state).toBe('connected')
  })

  it('changes the sample rate and says so', async () => {
    const r = await setup()
    await until(() => r.segments.length >= 1)
    const result = await r.meter.setRate(5)
    expect(result.ok).toBe(true)
    expect(r.emulator.received).toContain('SSR0005')
    expect(r.meters.at(-1)!.rateMs).toBe(5)
    await until(() => r.blocks.some((b) => b.dt === 5))
  })

  it('reconnects after the link drops and marks the segment as a reconnect', async () => {
    const r = await setup()
    await until(() => r.segments.length >= 1)
    r.emulator.dropConnection()
    await until(() => r.segments.some((s) => s.start === 'reconnect'), 5000)
    expect(r.meter.state).toBe('connected')
    const reconnect = r.segments.find((s) => s.start === 'reconnect')!
    expect(reconnect.gapBefore!.samples).toBeGreaterThan(0)
  })

  it('tries only the address it was given, never another meter on the link', async () => {
    let asked = false
    const meter = new TsiMeter({
      host: '127.0.0.1',
      port: 1,
      rateMs: 10,
      candidates: () => {
        asked = true
        return ['127.0.0.1']
      },
    })
    await expect(meter.start()).rejects.toThrow(/127\.0\.0\.1/)
    expect(asked).toBe(false)
  })

  it('reports a meter that is not there without hanging', async () => {
    const meter = new TsiMeter({ host: '127.0.0.1', port: 1, rateMs: 10, candidates: () => [] })
    await expect(meter.start()).rejects.toThrow(/No TSI meter answered/)
    expect(meter.state).toBe('disconnected')
  })
})
