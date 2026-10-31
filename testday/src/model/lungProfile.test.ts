import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { frcOf, hrVeFromAthleteYaml, lungsFromMedikro, veFromHr } from './lungProfile'

// Fixtures are medikro-xml's de-identified test exports; the expected values
// are what its parse_medikro.py reads from them.
const read = (name: string) => new TextDecoder('iso-8859-1').decode(readFileSync(new URL(name, import.meta.url)))

describe('Medikro import', () => {
  it('reads height, sex, age and the pre best curve as parse_medikro.py does', () => {
    const l = lungsFromMedikro(read('./medikro.fixture.xml'))
    expect(l).toMatchObject({ heightCm: 170, sex: 2, spirometryDate: '2023-03-10', fvcL: 3.4, fev1L: 2.8 })
    expect(l.ageAtTestY).toBeCloseTo(43.18, 2)
  })

  it('takes the baseline in an exercise-challenge export', () => {
    expect(lungsFromMedikro(read('./medikro-challenge.fixture.xml'))).toMatchObject({ fvcL: 4.0, fev1L: 3.4 })
  })

  it('predicts FRC from the age on the day', () => {
    const l = lungsFromMedikro(read('./medikro.fixture.xml'))
    const frc = frcOf({ ...l, birthDate: undefined }, new Date('2023-03-10'))!
    expect(frc.frcL).toBeGreaterThan(2)
    expect(frc.frcL).toBeLessThan(3.5)
    expect(frcOf({ ...l, measuredFrcL: 3.1 })!).toEqual({ frcL: 3.1, source: 'measured' })
    expect(frcOf(undefined)).toBeNull()
  })

  it('refuses a file that is not a Medikro export', () => {
    expect(() => lungsFromMedikro('<html></html>')).toThrow(/SpiroXML2/)
  })
})

describe('HR–VE curve import', () => {
  const yaml = `id: X01
vo2max_tests: []
- valid_from: '2015-05-15'
  modality: roller_ski
  points:
  - heart_rate: 100.0
    ve: 40.0
  - heart_rate: 150.0
    ve: 90.0
- valid_from: '2023-08-14'
  modality: treadmill
  points:
  - heart_rate: 50.0
    ve: 7.0
    constructed: true
  - heart_rate: 150.0
    ve: 80.0
  - heart_rate: 190.0
    ve: 160.0
notes: x
`
  it('takes the newest period', () => {
    const c = hrVeFromAthleteYaml(yaml)
    expect(c.label).toBe('treadmill 2023-08-14')
    expect(c.points).toHaveLength(3)
    expect(veFromHr(c, 170)).toBeCloseTo(120)
    expect(veFromHr(c, 250)).toBe(160)
    expect(veFromHr(c, null)).toBeNull()
  })
})
