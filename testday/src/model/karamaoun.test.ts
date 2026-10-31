import { describe, expect, it } from 'vitest'
import fixture from './karamaoun.fixture.json'
import { fig2Curve, fig2Reference, gliFrcL, hautFlux, personalThreshold } from './karamaoun'

// The fixture is R/karamaoun_fig2.R and R/gli2021_static.R in the ventilation
// project, the implementation this ports. Regenerate it there if either moves.

describe('Haut 2021 port', () => {
  for (const c of fixture.haut) {
    it(`matches R at FRC ${c.frc} L, VE ${c.ve}, ${c.t} °C / ${c.rh} %`, () => {
      const ts = hautFlux(c.frc, c.ve, c.t, c.rh)!
      ts.forEach((v, i) => expect(v).toBeCloseTo(c.haut[i], 4))
    })
  }
})

describe('Karamaoun Fig 2', () => {
  it('reproduces Table 2 trachea at FRC 3 L', () => {
    const t2: Record<number, number> = { 75: 0.285, 80: 0.304, 85: 0.323, 100: 0.379, 115: 0.434 }
    for (const [ve, j] of Object.entries(t2)) expect(fig2Reference(3, Number(ve))[0]).toBeCloseTo(j, 2)
  })

  it('crosses the upper band edge where the Results say', () => {
    expect(personalThreshold(3, 19, 55).reference[1]).toBeGreaterThan(70)
    expect(personalThreshold(3, 19, 55).reference[1]).toBeLessThan(75)
    expect(personalThreshold(3.5, 19, 55).reference[1]).toBeGreaterThan(75)
    expect(personalThreshold(3.5, 19, 55).reference[1]).toBeLessThan(80)
  })

  it('matches R thresholds in the TSI room', () => {
    const t = personalThreshold(fixture.threshold.frc, fixture.threshold.t, fixture.threshold.rh)
    expect(t.reference[1]).toBeCloseTo(fixture.threshold.ref, 0)
    expect(t.hautShifted[1]).toBeCloseTo(fixture.threshold.haut_shifted, 0)
  })

  it('shift is the identity in the paper air, and colder air raises the Haut-shifted threshold', () => {
    expect(fig2Curve(3.2, 90, 19, 55).karamaoun).toEqual(fig2Reference(3.2, 90))
    const room = personalThreshold(3.6, 19, 55)
    const cold = personalThreshold(3.6, -10, 80)
    expect(cold.hautShifted[1]).toBeGreaterThan(room.hautShifted[1])
    expect(cold.waterDeficit[1]).toBeLessThan(room.waterDeficit[1])
  })

  it('flags extrapolation', () => {
    expect(fig2Curve(3.2, 90, 19, 55).extrapolated).toBe(false)
    expect(fig2Curve(3.7, 90, 19, 55).extrapolated).toBe(true)
  })
})

describe('GLI 2021 FRC', () => {
  it('matches R', () => {
    expect(gliFrcL(1, 33.78, 184)).toBeCloseTo(fixture.gli_frc, 6)
    expect(gliFrcL(2, 40, 165)).toBeCloseTo(fixture.gli_frc_f, 6)
  })
})
