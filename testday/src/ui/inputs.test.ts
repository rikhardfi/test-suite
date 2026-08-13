import { describe, expect, it } from 'vitest'
import { formatDuration, formatNumber, parseDuration, parseNumber } from './inputs'

describe('parseNumber', () => {
  /**
   * The bug this exists for: `Number('')` is 0, so a controlled numeric input
   * whose state is a number renders a "0" back into the field the instant it is
   * cleared. Type 5 after it and the field reads "05", and no keystroke removes
   * the zero. Returning null for a field that does not yet hold a number is
   * what breaks that loop.
   */
  it('returns nothing for an empty field rather than zero', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('   ')).toBeNull()
  })

  it('returns nothing for a half-typed number', () => {
    expect(parseNumber('-')).toBeNull()
    expect(parseNumber('.')).toBeNull()
    expect(parseNumber('-.')).toBeNull()
  })

  it('reads a number once there is one', () => {
    expect(parseNumber('0')).toBe(0)
    expect(parseNumber('5')).toBe(5)
    expect(parseNumber('-2.5')).toBe(-2.5)
    expect(parseNumber(' 240 ')).toBe(240)
  })

  /** A Finnish keyboard produces a comma, and it means a decimal point. */
  it('accepts a comma as a decimal separator', () => {
    expect(parseNumber('2,5')).toBe(2.5)
  })

  it('refuses text that is not a number', () => {
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('5 W')).toBeNull()
  })
})

describe('formatNumber', () => {
  it('drops the trailing noise a float leaves behind', () => {
    expect(formatNumber(2.5)).toBe('2.5')
    expect(formatNumber(240)).toBe('240')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
  })
})

describe('parseDuration', () => {
  it('reads mm:ss the way it is spoken', () => {
    expect(parseDuration('4:30')).toBe(270)
    expect(parseDuration('0:45')).toBe(45)
    expect(parseDuration('10:00')).toBe(600)
  })

  it('reads h:mm:ss', () => {
    expect(parseDuration('1:02:03')).toBe(3723)
  })

  /**
   * A bare number stays seconds. Every protocol saved before this field existed
   * holds seconds, and reinterpreting them as minutes would make every one of
   * them sixty times longer: a far worse bug than the one being fixed.
   */
  it('reads a bare number as seconds, not minutes', () => {
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('240')).toBe(240)
  })

  it('allows a leading part above 59, since 90:00 is ninety minutes', () => {
    expect(parseDuration('90:00')).toBe(5400)
  })

  it('refuses a seconds part that is not a real number of seconds', () => {
    expect(parseDuration('4:60')).toBeNull()
    expect(parseDuration('1:75:00')).toBeNull()
  })

  it('returns nothing while the field is empty or half-typed', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('4:')).toBeNull()
    expect(parseDuration(':')).toBeNull()
    expect(parseDuration('abc')).toBeNull()
  })
})

describe('formatDuration', () => {
  it('prints what parseDuration reads back', () => {
    for (const seconds of [0, 45, 90, 270, 600, 3723, 5400]) {
      expect(parseDuration(formatDuration(seconds))).toBe(seconds)
    }
  })

  it('drops the hours when there are none', () => {
    expect(formatDuration(270)).toBe('4:30')
    expect(formatDuration(3723)).toBe('1:02:03')
  })

  it('refuses to print a negative duration as if it were one', () => {
    expect(formatDuration(-5)).toBe('')
  })
})
