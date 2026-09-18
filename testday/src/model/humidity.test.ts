import { describe, expect, it } from 'vitest'
import { saturationPressurePa, waterContentMgL, waterContentOf } from './humidity'

describe('water content of air', () => {
  // The same three points the ventilation project pins its Buck equation to.
  it('gives the saturation pressures the ventilation project gives', () => {
    expect(saturationPressurePa(0)).toBeCloseTo(611.21, 2)
    expect(saturationPressurePa(20) / 1000).toBeCloseTo(2.338, 2)
    expect(saturationPressurePa(37) / 1000).toBeCloseTo(6.275, 1)
  })

  // `tsi_water_content_mg_l(23, 50)` is pinned at 10.3 in R/tsi.R's own tests.
  it('agrees with the TSI analysis on room air', () => {
    expect(waterContentMgL(23, 50)).toBeCloseTo(10.27, 2)
  })

  it('shows why relative humidity alone says little', () => {
    expect(waterContentMgL(-10, 50)).toBeLessThan(1.5)
    expect(waterContentMgL(37, 100)).toBeGreaterThan(43)
  })

  it('has nothing to say about half a reading', () => {
    expect(waterContentOf({ tempC: 21 })).toBeNull()
    expect(waterContentOf({ humidityPct: 40 })).toBeNull()
    expect(waterContentOf({ tempC: 21, humidityPct: 40 })).toBeCloseTo(7.3, 1)
  })
})
