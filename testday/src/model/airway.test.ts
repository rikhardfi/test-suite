import { describe, expect, it } from 'vitest'
import { exhalations, type Exhalation, type FlowRows } from './breaths'
import { airwayLoad, breathEnergy, btpsFactor, karamaounThresholdLMin, minutesAbove } from './airway'

/**
 * Every expected value below was computed by the ventilation project's own R
 * code (`R/tsi.R`, `R/dehydration.R`, `R/altitude.R`, `R/tsi_report.R`) on the
 * same inputs, so these tests fail the moment the two stop agreeing.
 */

// A 20 s synthetic session on the 10 ms grid: 4 s breaths at 60 L/min peak,
// a missing tenth of a second inside one inhalation.
function syntheticSession(): FlowRows {
  const n = 2000
  const flow: number[] = []
  const tempC: number[] = []
  const rhPct: number[] = []
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * (i * 0.01)) / 4)
    flow.push(60 * s)
    tempC.push(25 + 8 * Math.max(0, s))
    rhPct.push(60 + 30 * Math.max(0, s))
  }
  for (let i = 1049; i <= 1059; i++) flow[i] = NaN
  return { flow, tempC, rhPct, pressureKpa: new Array(n).fill(101.0), dtS: 0.01, t0: 0 }
}

describe('breaths', () => {
  it('finds the exhalations tsi_segments() finds, with the same plateau', () => {
    const found = exhalations(syntheticSession())
    expect(found).toHaveLength(5)
    expect(found.map((b) => Math.round(b.startAt))).toEqual([10, 4010, 8010, 12010, 16010])
    for (const b of found) {
      expect(b.durationS).toBeCloseTo(2, 6)
      expect(b.volumeStdL).toBeCloseTo(1.2732134, 6)
      expect(b.tempC).toBeCloseTo(31.01994, 4)
      expect(b.rhPct).toBeCloseTo(82.574776, 4)
    }
  })

  it('leaves out a breath still in progress', () => {
    const rows = syntheticSession()
    const cut = { ...rows, flow: rows.flow.slice(0, 1300), tempC: rows.tempC.slice(0, 1300), rhPct: rows.rhPct.slice(0, 1300), pressureKpa: rows.pressureKpa.slice(0, 1300) }
    // The exhalation from 12 s is cut at 13 s and touches the end.
    expect(exhalations(cut).map((b) => Math.round(b.startAt))).toEqual([10, 4010, 8010])
  })

  it('joins an exhalation across a short dropout and splits it across a long one', () => {
    const n = 600
    const flow = new Array(n).fill(-20)
    for (let i = 100; i < 300; i++) flow[i] = 30
    for (let i = 180; i < 200; i++) flow[i] = NaN // 0.2 s
    for (let i = 350; i < 550; i++) flow[i] = 30
    for (let i = 420; i < 500; i++) flow[i] = 0 // 0.8 s
    const rows: FlowRows = { flow, tempC: new Array(n).fill(30), rhPct: new Array(n).fill(80), pressureKpa: new Array(n).fill(101), dtS: 0.01, t0: 0 }
    expect(exhalations(rows).map((b) => b.durationS.toFixed(2))).toEqual(['2.00', '0.70', '0.50'])
  })
})

describe('airway energy', () => {
  const room = { tempC: 22, humidityPct: 40 }

  it('gives the energy and water tsi_breath_energy() gives', () => {
    const [b] = exhalations(syntheticSession())
    const e = breathEnergy(b, room)
    expect(e.lostJ).toBeCloseTo(77.524125, 3)
    expect(e.waterMg).toBeCloseTo(26.222864, 3)
  })

  it('recovers nothing when the gas leaves at 37 °C and saturated', () => {
    const b: Exhalation = { startAt: 0, endAt: 3000, durationS: 3, volumeStdL: 2, pressurePa: 101325, tempC: 37, rhPct: 100, saturated: true }
    const e = breathEnergy(b, room)
    expect(e.lostJ).toBeCloseTo(e.demandJ, 6)
  })

  it('converts standard litres to BTPS as tsi_btps_factor() does', () => {
    expect(btpsFactor(101325)).toBeCloseTo(1.12358, 4)
  })
})

describe('Karamaoun threshold', () => {
  it('is 85 L/min in the reference air and matches calculate_ve_threshold() elsewhere', () => {
    expect(karamaounThresholdLMin(19, 55)).toBeCloseTo(85, 4)
    expect(karamaounThresholdLMin(-10, 80)).toBeCloseTo(64.5673, 3)
    expect(karamaounThresholdLMin(23, 40)).toBeCloseTo(84.7945, 3)
    expect(karamaounThresholdLMin(0, 50, 95000)).toBeCloseTo(67.5393, 3)
  })

  it('is unreachable in air already at body water content', () => {
    expect(karamaounThresholdLMin(37, 100)).toBe(Infinity)
  })
})

describe('the 30 s load', () => {
  // A breath every 2 s, 1.5 Std L: 45 Std L/min, about 50.6 L/min BTPS.
  const log: Exhalation[] = Array.from({ length: 60 }, (_, i) => ({
    startAt: i * 2000,
    endAt: i * 2000 + 1000,
    durationS: 1,
    volumeStdL: 1.5,
    pressurePa: 101325,
    tempC: 33,
    rhPct: 90,
    saturated: false,
  }))

  it('says nothing until the log covers a window', () => {
    expect(airwayLoad(log, { now: 20_000, room: { tempC: 19, humidityPct: 55 } })).toBeNull()
  })

  it('says nothing when nobody has breathed into the meter for ten seconds', () => {
    expect(airwayLoad(log, { now: log[59].endAt + 11_000, room: { tempC: 19, humidityPct: 55 } })).toBeNull()
  })

  it('turns 15 breaths in 30 s into hourly rates', () => {
    const load = airwayLoad(log, { now: 100_000, room: { tempC: 19, humidityPct: 55 } })!
    expect(load.breaths).toBe(15)
    expect(load.veLMin).toBeCloseTo(45 * btpsFactor(101325), 6)
    const one = breathEnergy(log[0], { tempC: 19, humidityPct: 55 })
    expect(load.lostKjH).toBeCloseTo((15 * one.lostJ * 120) / 1000, 6)
    expect(load.recoveredKjH).toBeCloseTo(load.demandKjH - load.lostKjH, 6)
    expect(load.recoveredPct).toBeGreaterThan(0)
    expect(load.recoveredPct).toBeLessThan(100)
  })

  it('counts time above the threshold breath to breath, from the start of the test', () => {
    const btps = btpsFactor(101325)
    // 50.6 L/min against thresholds either side of it.
    expect(minutesAbove(log, 40, btps, 0, 120_000)).toBeCloseTo((119_000 - 29_000) / 60_000, 6)
    expect(minutesAbove(log, 60, btps, 0, 120_000)).toBe(0)
    expect(minutesAbove(log, 40, btps, 61_000, 120_000)).toBeCloseTo((119_000 - 61_000) / 60_000, 6)
  })
})
