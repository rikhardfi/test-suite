import { describe, expect, it } from 'vitest'
import fixture from './direction.fixture.json'
import { directionFromTemperature, exhalations } from './breaths'

// The fixture is R/tsi.R's tsi_direction_from_temperature() in the ventilation
// project on a synthetic 30 s record: 2 s out, 2 s in, the flow sign lost from
// 10 to 20 s, and a gas temperature that rises on every exhalation.
describe('directionFromTemperature', () => {
  it('matches the R implementation sample for sample', () => {
    const out = directionFromTemperature(fixture.flow, fixture.temp, fixture.dt)
    let differ = 0
    out.forEach((v, i) => {
      if (Math.abs(v - fixture.out[i]) > 1e-3) differ++
    })
    expect(differ).toBe(0)
  })

  it('splits the breaths the lost sign had merged', () => {
    const rows = (flow: number[]) => ({
      flow,
      tempC: fixture.temp,
      rhPct: fixture.flow.map(() => 80),
      pressureKpa: fixture.flow.map(() => 101.3),
      dtS: fixture.dt,
      t0: 0,
    })
    const raw = exhalations(rows(fixture.flow))
    const fixed = exhalations(rows(directionFromTemperature(fixture.flow, fixture.temp, fixture.dt)))
    expect(fixed.length).toBeGreaterThan(raw.length)
    expect(fixed.length).toBeGreaterThanOrEqual(6)
  })

  it('keeps the meter sign where the temperature does not swing', () => {
    const flow = [0, 50, 100, 50, 0, -50, -100, -50, 0]
    expect(directionFromTemperature(flow, flow.map(() => 20), 0.1)).toEqual(flow)
  })
})
