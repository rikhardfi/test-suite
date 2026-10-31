import { describe, expect, it } from 'vitest'
import { detectCircuit } from './circuit'
import { exhalations, type FlowRows } from './breaths'

/** Rows on the 10 ms grid from a flow and temperature at each second. */
function rows(seconds: number, flowAt: (t: number) => number, tempAt: (t: number) => number = () => 20): FlowRows {
  const n = Math.round(seconds / 0.01)
  const t = Array.from({ length: n }, (_, i) => i * 0.01)
  return {
    flow: t.map(flowAt),
    tempC: t.map(tempAt),
    rhPct: t.map(() => 60),
    pressureKpa: t.map(() => 101.3),
    dtS: 0.01,
    t0: 0,
  }
}

// Breathing on a one-way limb: 2 s exhalations, then near zero while the
// athlete breathes in past the meter.
const breathing = (t: number) => (t % 4 < 2 ? 60 * Math.sin((Math.PI * (t % 4)) / 2) : 0)

describe('what is on the circuit', () => {
  it('reads breathing as breathing', () => {
    expect(detectCircuit(rows(45, breathing, () => 32))).toBeNull()
  })

  it('reads a steady 9 L/min at room temperature as the fan', () => {
    const state = detectCircuit(rows(20, (t) => 9 + 0.5 * Math.sin(7 * t), () => 11))
    expect(state?.kind).toBe('fan')
    expect(state?.flowLMin).toBeCloseTo(9, 0)
  })

  it('reads high flow, or hot gas, as the dryer', () => {
    expect(detectCircuit(rows(20, () => 45, () => 26))?.kind).toBe('dryer')
    expect(detectCircuit(rows(20, () => 15, () => 50))?.kind).toBe('dryer')
  })

  it('needs ten seconds of it', () => {
    expect(detectCircuit(rows(20, (t) => (t < 12 ? breathing(t) : 9)))).toBeNull()
  })

  it('holds through a dip but lets go when the flow stops', () => {
    const dip = rows(20, (t) => (t > 15 && t < 16.5 ? 0.2 : 9))
    expect(detectCircuit(dip)).toBeNull()
    expect(detectCircuit(dip, 'fan')?.kind).toBe('fan')
    const stopped = rows(20, (t) => (t > 17 ? 0.1 : 9))
    expect(detectCircuit(stopped, 'fan')).toBeNull()
  })

  // 2026-10-02: high-ventilation bouts between fan runs. Exhalation takes over
  // half of each 3 s breath, and the meter showed inspiration as a positive hump
  // of about 25 L/min with only brief dips below zero. Every window is over 95 %
  // positive, and the old hold never saw flow stop.
  const highVe = (t: number) => {
    const p = t % 3
    if (p < 1.9) return 25 + 100 * Math.sin((Math.PI * p) / 1.9)
    if (p < 2.0 || p > 2.9) return -5
    return 25
  }
  const fanThenBreathing = (t: number) => (t < 30 ? 9 + 0.5 * Math.sin(7 * t) : highVe(t - 30))

  it('reads high-ventilation breathing with little negative flow as breathing', () => {
    const fanOnly = rows(30, fanThenBreathing)
    expect(detectCircuit(fanOnly)?.kind).toBe('fan')
    const all = rows(75, fanThenBreathing)
    let state = detectCircuit(fanOnly)?.kind ?? null
    const onDuringBreathing: number[] = []
    // As the meter calls it: every 250 ms, with the last answer for the hold.
    for (let end = 3000; end <= all.flow.length; end += 25) {
      const r = { ...all, flow: all.flow.slice(0, end), tempC: all.tempC.slice(0, end) }
      state = detectCircuit(r, state)?.kind ?? null
      if (state && end * 0.01 > 37) onDuringBreathing.push(end * 0.01)
    }
    expect(onDuringBreathing).toEqual([])
    expect(detectCircuit(rows(45, highVe))).toBeNull()
    expect(detectCircuit(rows(45, highVe), 'fan')).toBeNull()
  })

  it('lets go of the fan when one-way breathing keeps the flow up most of the time', () => {
    // Exhalation 2.4 s of every 3 s, near zero only in the 0.6 s inspiration.
    const oneWay = (t: number) => (t % 3 < 2.4 ? 10 + 90 * Math.sin((Math.PI * (t % 3)) / 2.4) : 0)
    const r = rows(45, (t) => (t < 30 ? 9 : oneWay(t - 30)))
    expect(detectCircuit(r, 'fan')).toBeNull()
  })

  it('still holds the fan, then reads the dryer, when the dryer replaces it', () => {
    const swap = (t: number) => (t < 20 ? 9 : 40 + Math.sin(5 * t))
    expect(detectCircuit(rows(25, swap), 'fan')?.kind).toBe('fan')
    expect(detectCircuit(rows(32, swap), 'fan')?.kind).toBe('dryer')
  })

  it('does not count fan flow as an exhalation', () => {
    const fanBetweenBreaths = rows(45, (t) => (t > 10 && t < 30 ? 9 : breathing(t)), () => 30)
    const found = exhalations(fanBetweenBreaths)
    // 0 and 4 s before the fan, 32, 36 and 40 s after; 8 s runs into the fan, 44 s into the end.
    expect(found).toHaveLength(5)
    expect(Math.max(...found.map((b) => b.durationS))).toBeLessThan(8)
  })
})
