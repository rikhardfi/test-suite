import { describe, expect, it } from 'vitest'
import { addAthlete, removeAthlete, switchAthlete, withProfiles, type Settings } from './storage'

const base = (): Settings => ({ athlete: { name: 'A', massKg: 70, ftpWatts: 300 }, wheelCircumferenceM: 2.1 })

describe('athlete profiles', () => {
  it('gives the open athlete an id and keeps it in the list', () => {
    const s = withProfiles(base())
    expect(s.athlete.id).toBeTruthy()
    expect(s.athletes).toEqual([s.athlete])
    expect(withProfiles(s)).toEqual(s)
  })

  it('keeps edits when switching back and forth', () => {
    let s = withProfiles(base())
    const a = s.athlete.id!
    s = addAthlete(s, { name: 'B', massKg: 80, ftpWatts: 250 })
    s = { ...s, athlete: { ...s.athlete, ftpWatts: 260 } }
    const b = s.athlete.id!
    s = switchAthlete(s, a)
    expect(s.athlete.name).toBe('A')
    s = switchAthlete(s, b)
    expect(s.athlete.ftpWatts).toBe(260)
    expect(s.athletes).toHaveLength(2)
  })

  it('never deletes the last profile, and reopens another when the open one goes', () => {
    let s = addAthlete(withProfiles(base()), { name: 'B', massKg: 80, ftpWatts: 250 })
    s = removeAthlete(s, s.athlete.id!)
    expect(s.athlete.name).toBe('A')
    expect(removeAthlete(s, s.athlete.id!).athletes).toHaveLength(1)
  })
})
