import { describe, expect, it } from 'vitest'
import type { FlowBlock, FlowRecord, FlowSegment } from './flow'
import type { JournalRaw } from './journal'
import { DEFAULT_ATHLETE } from './protocol'
import { researchSidecar } from './research'
import { RESEARCH_COLUMNS, buildResearchGrid, gridStep } from './researchGrid'
import type { SessionRecord } from './session'
import { APP_VERSION } from './version'

const T0 = Date.UTC(2026, 8, 17, 11, 35, 0)

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's',
  protocolId: 'p',
  protocolName: 'Step',
  sport: 'run',
  athlete: { ...DEFAULT_ATHLETE, name: 'P-CODE' },
  startedAt: T0,
  endedAt: T0 + 2000,
  samples: [
    { t: 0, stepIndex: 0, phase: 'work', targetKph: 10, heartRate: 150 },
    { t: 1, stepIndex: 1, phase: 'work', targetKph: 12, heartRate: 151 },
    { t: 2, stepIndex: 1, phase: 'work', targetKph: 12, heartRate: 152 },
  ],
  lactate: [],
  events: [{ kind: 'start', at: T0 }],
  ...over,
})

const block = (seg: number, at0: number, n: number): FlowBlock => ({
  type: 'block',
  seg,
  i0: 0,
  at0,
  dt: 10,
  f: Array.from({ length: n }, (_, k) => k),
  tc: Array(n).fill(31),
  p: Array(n).fill(98.6),
  rh: Array(n).fill(80),
  lp: Array(n).fill(0),
  tot: Array(n).fill(1),
})

const segment = (seg: number, anchorAt: number, n: number, gapSamples = 0): FlowSegment => ({
  type: 'segment',
  seg,
  anchorAt,
  n,
  dt: 10,
  observedDt: 10,
  start: seg === 0 ? 'first' : 'continuous',
  gapBefore: gapSamples ? { samples: gapSamples, ms: gapSamples * 10, volumeL: 0 } : null,
})

/** The CSV as objects, one per grid row. */
function table(parts: string[]) {
  const lines = parts.join('').trimEnd().split('\n')
  const header = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    expect(cells).toHaveLength(header.length)
    return Object.fromEntries(header.map((name, i) => [name, cells[i]]))
  })
}

describe('gridStep', () => {
  it('takes the fastest device, rounded down to a plain rate', () => {
    expect(gridStep([1000, 10])).toBe(10)
    expect(gridStep([1000, 247])).toBe(200)
    expect(gridStep([1000])).toBe(1000)
    expect(gridStep([1000, 1])).toBe(1)
  })
})

describe('buildResearchGrid', () => {
  it('runs at the flow meter rate and puts each row on the grid', () => {
    const flow: FlowRecord[] = [block(0, T0, 150), segment(0, T0, 150)]
    const grid = buildResearchGrid(session(), [], flow)
    expect(grid.stepMs).toBe(10)
    const rows = table(grid.csvParts)
    expect(rows[0].unix_ms).toBe(String(T0))
    expect(rows[1].unix_ms).toBe(String(T0 + 10))
    expect(rows[37].flow_l_min).toBe('37.000')
  })

  it('writes a slow measurement once, at its own time, and leaves the rows between blank', () => {
    const flow: FlowRecord[] = [block(0, T0, 250), segment(0, T0, 250)]
    const rows = table(buildResearchGrid(session(), [], flow).csvParts)
    // 1 Hz heart rate from the snapshot: rows 0, 100, 200.
    expect(rows.filter((r) => r.heart_rate_bpm !== '').map((r) => Number(r.unix_ms) - T0)).toEqual([0, 1000, 2000])
    expect(rows[50].heart_rate_bpm).toBe('')
  })

  it('carries protocol state on every row', () => {
    const flow: FlowRecord[] = [block(0, T0, 200), segment(0, T0, 200)]
    const rows = table(buildResearchGrid(session(), [], flow).csvParts)
    expect(rows[50]).toMatchObject({ step_index: '0', target_speed_kph: '10.00', phase: 'work' })
    expect(rows[150]).toMatchObject({ step_index: '1', target_speed_kph: '12.00' })
  })

  it('prefers native notifications, only from the device that owned the metric', () => {
    const raw: JournalRaw[] = [
      { type: 'raw', d: 'strap', at: T0 + 503, t: 0.5, v: { heartRate: 160 } },
      { type: 'raw', d: 'watch', at: T0 + 704, t: 0.7, v: { heartRate: 99 } },
    ]
    const events = [
      { kind: 'start', at: T0 },
      { kind: 'sourceChanged', at: T0 + 1, data: { metric: 'heartRate', from: '', to: 'strap', name: 'Strap' } },
    ]
    const flow: FlowRecord[] = [block(0, T0, 200), segment(0, T0, 200)]
    const grid = buildResearchGrid(session({ events }), raw, flow)
    const rows = table(grid.csvParts)
    expect(rows[50].heart_rate_bpm).toBe('160')
    expect(rows.filter((r) => r.heart_rate_bpm !== '')).toHaveLength(1)
    expect(grid.columnSources.heart_rate_bpm).toBe('native')
  })

  it('marks the rows a stream restart never sent', () => {
    const flow: FlowRecord[] = [block(0, T0, 50), segment(0, T0, 50), block(1, T0 + 580, 50), segment(1, T0 + 580, 50, 7)]
    const rows = table(buildResearchGrid(session(), [], flow).csvParts)
    expect(rows.slice(51, 58).every((r) => r.flow_gap === '1' && r.flow_l_min === '')).toBe(true)
    expect(rows[58].flow_l_min).toBe('0.000')
  })

  it('counts rows from before the start instead of dropping them silently', () => {
    const flow: FlowRecord[] = [block(0, T0 - 300, 100), segment(0, T0 - 300, 100)]
    const grid = buildResearchGrid(session(), [], flow)
    expect(grid.beforeStart.flow_l_min).toBe(30)
    expect(table(grid.csvParts)[0].flow_l_min).toBe('30.000')
  })

  it('falls back to one row a second without any fast device', () => {
    const grid = buildResearchGrid(session(), [], null)
    expect(grid.stepMs).toBe(1000)
    expect(table(grid.csvParts)).toHaveLength(3)
    expect(grid.columnSources.flow_l_min).toBe('none')
  })

  it('documents every column it writes, and where each came from', () => {
    const grid = buildResearchGrid(session(), [], [block(0, T0, 100), segment(0, T0, 100)])
    const header = grid.csvParts[0].trim().split(',')
    expect(header).toEqual(RESEARCH_COLUMNS.map((c) => c.name))
    const sidecar = JSON.parse(researchSidecar(session(), { appVersion: APP_VERSION, grid }))
    expect(sidecar.columns.map((c: { name: string }) => c.name)).toEqual(header)
    expect(sidecar.sampling.rateHz).toBe(100)
    expect(sidecar.sampling.columnSources.heart_rate_bpm).toBe('1 Hz snapshot')
    for (const name of header) expect(sidecar.sampling.columnSources[name]).toBeDefined()
  })
})
