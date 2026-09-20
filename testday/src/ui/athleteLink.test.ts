import { describe, expect, it } from 'vitest'
import { applyFrame } from './athleteLink'
import type { Sample } from '../model/session'

const samples = (from: number, count: number): Sample[] =>
  Array.from({ length: count }, (_, i) => ({ t: from + i, stepIndex: 0, phase: 'work' as const }))

describe('the athlete window feed', () => {
  it('appends what was recorded since the last frame', () => {
    const held = applyFrame(samples(0, 10), 10, samples(10, 2))
    expect(held?.map((s) => s.t)).toEqual([...Array(12).keys()])
  })

  it('starts over when the operator sends the record from the top', () => {
    expect(applyFrame(samples(0, 50), 0, samples(0, 3))).toHaveLength(3)
    expect(applyFrame(samples(0, 50), 0, [])).toHaveLength(0)
  })

  /** A window opened mid-test, or one that missed frames while it was hidden. */
  it('refuses a frame that would leave a gap, so the whole record is asked for again', () => {
    expect(applyFrame([], 120, samples(120, 1))).toBeNull()
    expect(applyFrame(samples(0, 10), 12, samples(12, 1))).toBeNull()
  })

  it('refuses a frame that overlaps what is already held', () => {
    expect(applyFrame(samples(0, 10), 8, samples(8, 3))).toBeNull()
  })
})
