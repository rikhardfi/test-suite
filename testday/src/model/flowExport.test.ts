import { describe, expect, it } from 'vitest'
import type { FlowBlock, FlowRecord, FlowSegment } from './flow'
import { flowRows, flowSidecar, protocolClock, withExhaled } from './flowExport'
import { SAMPLE_COLUMNS } from './research'
import { sampleRow, samplesToCsv } from './export'
import { DEFAULT_ATHLETE } from './protocol'
import type { SessionRecord } from './session'

const T0 = Date.UTC(2026, 8, 17, 10, 35, 0)

const block = (seg: number, i0: number, at0: number, n: number, over: Partial<FlowBlock> = {}): FlowBlock => ({
  type: 'block',
  seg,
  i0,
  at0,
  dt: 10,
  f: Array(n).fill(30),
  tc: Array(n).fill(31),
  p: Array(n).fill(98.6),
  rh: Array(n).fill(80),
  lp: Array(n).fill(0),
  tot: Array.from({ length: n }, (_, k) => k * 0.005),
  ...over,
})

const segment = (seg: number, anchorAt: number, n: number, over: Partial<FlowSegment> = {}): FlowSegment => ({
  type: 'segment',
  seg,
  anchorAt,
  n,
  dt: 10,
  observedDt: 10,
  start: seg === 0 ? 'first' : 'continuous',
  gapBefore: null,
  ...over,
})

describe('protocolClock', () => {
  const clock = protocolClock([
    { kind: 'start', at: T0 },
    { kind: 'pause', at: T0 + 35_000 },
    { kind: 'resume', at: T0 + 40_000 },
    { kind: 'jump', at: T0 + 50_000 },
  ])

  it('is blank before the test started', () => {
    expect(clock(T0 - 1)).toEqual({ elapsedS: null, running: false })
  })

  it('runs with the wall clock, then stands still while paused', () => {
    expect(clock(T0 + 10_000)).toEqual({ elapsedS: 10, running: true })
    expect(clock(T0 + 37_000)).toEqual({ elapsedS: 35, running: false })
  })

  it('carries on from where it stopped, and a jump does not move it', () => {
    expect(clock(T0 + 45_000)).toEqual({ elapsedS: 40, running: true })
    expect(clock(T0 + 60_000)).toEqual({ elapsedS: 55, running: true })
  })
})

describe('flowRows', () => {
  it('re-times from the last segment record, not a partial one or the blocks', () => {
    const records: FlowRecord[] = [
      block(0, 0, T0 + 7, 3),
      segment(0, T0 + 5, 3, { partial: true }),
      segment(0, T0 + 2, 3),
    ]
    expect(flowRows(records).map((r) => r.unixMs)).toEqual([T0 + 2, T0 + 12, T0 + 22])
  })

  it('fills a restart gap with empty rows on the same grid', () => {
    const records: FlowRecord[] = [
      block(0, 0, T0, 3),
      segment(0, T0, 3),
      block(1, 0, T0 + 60, 2),
      segment(1, T0 + 60, 2, { gapBefore: { samples: 3, ms: 30, volumeL: 0.015 } }),
    ]
    const rows = flowRows(records)
    expect(rows.map((r) => r.unixMs - T0)).toEqual([0, 10, 20, 30, 40, 50, 60, 70])
    expect(rows.map((r) => r.gap)).toEqual([false, false, false, true, true, true, false, false])
    expect(rows[3].flow).toBeNull()
  })

  it('keeps a crashed segment on its provisional block times', () => {
    const rows = flowRows([block(0, 0, T0 + 3, 2)])
    expect(rows.map((r) => r.unixMs)).toEqual([T0 + 3, T0 + 13])
  })
})

const session = (): SessionRecord => ({
  id: 's',
  protocolId: 'p',
  protocolName: 'Step',
  sport: 'run',
  athlete: { ...DEFAULT_ATHLETE, name: 'Someone' },
  startedAt: T0,
  samples: [
    { t: 0, stepIndex: 0, phase: 'work' },
    { t: 1, stepIndex: 0, phase: 'work' },
    { t: 2, stepIndex: 0, phase: 'work' },
  ],
  lactate: [],
  events: [{ kind: 'start', at: T0 }],
})

describe('withExhaled', () => {
  it('averages the second of protocol time ending at each sample', () => {
    // 2 s of rows at 10 ms: the first second at 20 L/min, the second at 40.
    const f = [...Array(100).fill(20), ...Array(100).fill(40)]
    const rows = flowRows([block(0, 0, T0 + 1, 200, { f, rh: Array(200).fill(70) }), segment(0, T0 + 1, 200)])
    const out = withExhaled(session(), rows)
    expect(out.samples[1].exhaledFlowLMin).toBeCloseTo(20)
    expect(out.samples[2].exhaledFlowLMin).toBeCloseTo(40)
    expect(out.samples[1].exhaledRhPct).toBeCloseTo(70)
    expect(out.samples[1].exhaledCoverage).toBeCloseTo(1)
    // Nothing is invented for a second the meter did not cover.
    expect(out.samples[0].exhaledFlowLMin).toBeUndefined()
  })

  it('leaves humidity blank for a second that touched saturation, and says what was missing', () => {
    const rh = Array(200).fill(95)
    rh[150] = 100.1
    const records: FlowRecord[] = [
      block(0, 0, T0 + 1, 150, { rh: rh.slice(0, 150) }),
      segment(0, T0 + 1, 150),
      block(1, 0, T0 + 1 + 1600, 40, { rh: rh.slice(160, 200).map((_, k) => (k === 0 ? 100.1 : 95)) }),
      segment(1, T0 + 1 + 1600, 40, { gapBefore: { samples: 10, ms: 100, volumeL: 0.05 } }),
    ]
    const out = withExhaled(session(), flowRows(records))
    expect(out.samples[1].exhaledRhPct).toBeCloseTo(95)
    expect(out.samples[2].exhaledRhPct).toBeUndefined()
    expect(out.samples[2].exhaledCoverage).toBeCloseTo(0.9)
  })

  it('writes the summary into the appended CSV columns and nowhere else', () => {
    const rows = flowRows([block(0, 0, T0 + 1, 100), segment(0, T0 + 1, 100)])
    const out = withExhaled(session(), rows)
    const row = sampleRow(out.samples[1])
    expect(row).toHaveLength(SAMPLE_COLUMNS.length)
    expect(row[SAMPLE_COLUMNS.findIndex((c) => c.name === 'exp_flow_l_min')]).toBe('30.000')
    expect(samplesToCsv(session()).split('\n')[0].split(',').slice(-4)).toEqual([
      'exp_flow_l_min',
      'exp_gas_temp_c',
      'exp_rh_pct',
      'exp_flow_coverage',
    ])
  })
})

describe('flowSidecar', () => {
  it('summarises gaps, saturation and the meter, and states the caveats', () => {
    const records: FlowRecord[] = [
      {
        type: 'meter',
        at: T0,
        host: '169.254.0.1',
        model: '533002',
        serial: 'X',
        firmware: '1',
        calibrationDate: 'd',
        rateMs: 10,
        flowUnits: 'S',
        humidityCompensation: true,
        directionSensor: false,
      },
      block(0, 0, T0, 2, { rh: [100.1, 50] }),
      segment(0, T0, 2),
      block(1, 0, T0 + 40, 2),
      segment(1, T0 + 40, 2, { gapBefore: { samples: 2, ms: 20, volumeL: null } }),
    ]
    const sidecar = flowSidecar(records, flowRows(records))
    expect(sidecar.meter).not.toHaveProperty('host')
    expect(sidecar.gaps).toEqual({ count: 1, totalMs: 20, volumeL: 0, unmeasured: 1 })
    // A gap before the first recorded segment happened before the session.
    const late = flowSidecar(records.slice(3), flowRows(records.slice(3)))
    expect(late.gaps.count).toBe(0)
    expect(sidecar.humiditySaturatedShare).toBeCloseTo(0.25)
    expect(sidecar.caveats.join(' ')).toMatch(/not BTPS/)
    expect(sidecar.caveats.join(' ')).toMatch(/reverse flow reads positive/)
  })
})
