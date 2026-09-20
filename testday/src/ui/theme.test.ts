import { describe, expect, it } from 'vitest'
import { axisFloor } from './theme'

describe('where a value axis starts', () => {
  it('starts at zero unless asked to fit', () => {
    expect(axisFloor(false, 250, 380)).toBe(0)
  })

  it('opens just under the lowest step, on a round number', () => {
    // A bike step test from 250 W with the axis topping out at 380 W.
    expect(axisFloor(true, 250, 380)).toBe(240)
    // A treadmill test from 10 km/h.
    expect(axisFloor(true, 10, 19.55)).toBe(8)
  })

  it('never goes below zero', () => {
    expect(axisFloor(true, 2, 400)).toBe(0)
  })

  it('falls back to zero when there is nothing to fit to', () => {
    expect(axisFloor(true, Infinity, 100)).toBe(0)
    expect(axisFloor(true, 0, 100)).toBe(0)
    expect(axisFloor(true, 120, 100)).toBe(0)
  })
})
