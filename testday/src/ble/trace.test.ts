import { describe, expect, it } from 'vitest'
import { TraceRecorder, fromHex, replay, toHex, type Trace } from './trace'
import { parseAranet, parseHeartRate } from './parse'
import { METRIC_INFO, isEnvironment, staleAfterMs } from './metrics'
import type { MetricKey } from './types'

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe('hex round-trip', () => {
  it('survives a trip through hex unchanged', () => {
    const original = view(0x00, 0x0f, 0xff, 0x10, 0xa5)
    expect(toHex(original)).toBe('000fff10a5')
    const back = fromHex('000fff10a5')
    expect(back.byteLength).toBe(5)
    expect(back.getUint8(2)).toBe(0xff)
  })

  it('tolerates the separators a human puts in when pasting bytes', () => {
    expect(fromHex('00 0f ff').byteLength).toBe(3)
    expect(fromHex('00:0f:ff').getUint8(1)).toBe(0x0f)
  })
})

describe('TraceRecorder', () => {
  it('records nothing until it is started', () => {
    const recorder = new TraceRecorder()
    recorder.capture('d', 'Strap', '0x2a37', view(0x00, 0x50))
    expect(recorder.size).toBe(0)
  })

  it('keeps the bytes and what the parser made of them', () => {
    const recorder = new TraceRecorder()
    recorder.start(1000)
    recorder.capture('d', 'Strap', '0x2a37', view(0x00, 0x50), { heartRate: 80 }, 1250)
    const trace = recorder.toTrace('Polar H10, warm-up')

    expect(trace.entries).toHaveLength(1)
    expect(trace.entries[0]).toMatchObject({
      t: 250,
      deviceName: 'Strap',
      hex: '0050',
      decoded: { heartRate: 80 },
    })
    expect(trace.note).toBe('Polar H10, warm-up')
  })

  /** A capture left running for a whole test day must not grow without limit. */
  it('keeps the most recent packets once it is full', () => {
    const recorder = new TraceRecorder(3)
    recorder.start(0)
    for (let i = 0; i < 6; i++) recorder.capture('d', 'S', 'c', view(i), undefined, i)
    expect(recorder.size).toBe(3)
    // A capture is normally stopped just after the interesting thing happened,
    // so the tail is the half worth keeping.
    expect(recorder.toTrace().entries.map((e) => e.hex)).toEqual(['03', '04', '05'])
  })
})

describe('replay', () => {
  const trace = (decoded: Record<string, unknown>): Trace => ({
    format: 'testday-ble-trace',
    version: 1,
    startedAt: '2026-08-13T06:43:21.000Z',
    entries: [{ t: 0, deviceId: 'd', deviceName: 'S', characteristic: 'hr', hex: '0050', decoded }],
  })

  it('reports nothing when the parser still agrees with the capture', () => {
    expect(replay(trace({ heartRate: 80 }), () => parseHeartRate)).toEqual([])
  })

  /**
   * The point of the harness: change a parser, replay every trace ever captured
   * from real hardware, and see exactly which real packets the change affects.
   */
  it('reports a packet the parser now reads differently', () => {
    const disagreements = replay(trace({ heartRate: 99 }), () => parseHeartRate)
    expect(disagreements).toHaveLength(1)
    expect(disagreements[0].captured).toEqual({ heartRate: 99 })
    expect(disagreements[0].replayed).toEqual({ heartRate: 80 })
    // The bytes travel with the disagreement, so it can be reasoned about.
    expect(disagreements[0].hex).toBe('0050')
  })

  it('reports a parser that now throws instead of crashing the replay', () => {
    const disagreements = replay(trace({ heartRate: 80 }), () => () => {
      throw new Error('index out of range')
    })
    expect(disagreements[0].replayed).toEqual({ error: 'index out of range' })
  })

  it('skips characteristics it has no parser for', () => {
    expect(replay(trace({ heartRate: 80 }), () => null)).toEqual([])
  })
})

describe('the Aranet4 parser', () => {
  // 700 ppm, 21.0 °C (420 × 0.05), 1013.2 hPa (10132 × 0.1), 41% RH.
  const readings = view(0xbc, 0x02, 0xa4, 0x01, 0x94, 0x27, 0x29, 0x64, 0x01)

  it('decodes the four environment values', () => {
    const out = parseAranet(readings)
    expect(out.co2Ppm).toBe(700)
    expect(out.ambientTempC).toBeCloseTo(21, 6)
    expect(out.pressureHpa).toBeCloseTo(1013.2, 4)
    expect(out.humidityPct).toBe(41)
  })

  /**
   * The device reports zero CO₂ in the first minute after power-on, before it
   * has measured anything. Recorded as a value it would read as clean air.
   */
  it('drops a CO₂ reading the device has not taken yet', () => {
    const notYet = view(0x00, 0x00, 0xa4, 0x01, 0x94, 0x27, 0x29, 0x64, 0x01)
    expect(parseAranet(notYet).co2Ppm).toBeUndefined()
    // The rest of the packet is still good.
    expect(parseAranet(notYet).ambientTempC).toBeCloseTo(21, 6)
  })

  it('returns nothing rather than throwing on a short packet', () => {
    expect(parseAranet(view(0x01, 0x02))).toEqual({})
  })
})

describe('metric metadata', () => {
  it('describes every metric key exactly once', () => {
    const keys = Object.keys(METRIC_INFO) as MetricKey[]
    for (const key of keys) {
      expect(METRIC_INFO[key].label.length).toBeGreaterThan(0)
      expect(METRIC_INFO[key].typicalIntervalS).toBeGreaterThan(0)
    }
  })

  it('separates the slow environment channels from the per-second ones', () => {
    expect(isEnvironment('co2Ppm')).toBe(true)
    expect(isEnvironment('humidityPct')).toBe(true)
    expect(isEnvironment('power')).toBe(false)
    expect(isEnvironment('ventilationLMin')).toBe(false)
  })

  /**
   * A five-second staleness rule is right for a power meter and wrong for a
   * monitor that speaks every five minutes: applying it there would blank a
   * reading that is entirely current.
   */
  it('gives a slow sensor a staleness window that matches how it reports', () => {
    expect(staleAfterMs('power')).toBe(5000)
    expect(staleAfterMs('co2Ppm')).toBe(900_000)
  })
})
