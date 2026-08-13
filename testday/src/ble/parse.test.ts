import { describe, expect, it } from 'vitest'
import {
  RevolutionCounter,
  parseCoreTemperature,
  parseCsc,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  parseRsc,
  parseTreadmillData,
} from './parse'

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]

describe('parseHeartRate', () => {
  it('reads an 8-bit heart rate', () => {
    expect(parseHeartRate(view(0x00, 172))).toEqual({ heartRate: 172 })
  })

  it('reads a 16-bit heart rate when the format bit is set', () => {
    expect(parseHeartRate(view(0x01, ...le16(300)))).toEqual({ heartRate: 300 })
  })

  it('skips energy expended before reading RR intervals', () => {
    // flags: 16-bit off, energy present (bit 3), RR present (bit 4)
    const result = parseHeartRate(view(0b0001_1000, 60, ...le16(1234), ...le16(1024), ...le16(512)))
    expect(result.heartRate).toBe(60)
    expect(result.rrIntervalsMs).toEqual([1000, 500])
  })
})

describe('parseCyclingPower', () => {
  it('reads instantaneous power', () => {
    expect(parseCyclingPower(view(...le16(0), ...le16(275))).power).toBe(275)
  })

  it('handles negative power', () => {
    expect(parseCyclingPower(view(...le16(0), 0xf6, 0xff)).power).toBe(-10)
  })

  it('derives cadence from crank revolutions, skipping earlier optional fields', () => {
    const crank = new RevolutionCounter(1024, 0x10000)
    // flags: pedal balance (bit 0) + accumulated torque (bit 2) + crank data (bit 5)
    const flags = (1 << 0) | (1 << 2) | (1 << 5)
    const first = parseCyclingPower(
      view(...le16(flags), ...le16(200), 50, ...le16(999), ...le16(100), ...le16(0)),
      crank,
    )
    expect(first.cadence).toBeUndefined()

    // One crank revolution, 1024 time units later = exactly 1 s = 60 rpm.
    const second = parseCyclingPower(
      view(...le16(flags), ...le16(200), 50, ...le16(999), ...le16(101), ...le16(1024)),
      crank,
    )
    expect(second.power).toBe(200)
    expect(second.cadence).toBe(60)
  })

  it('wraps the 16-bit crank event timer', () => {
    const crank = new RevolutionCounter(1024, 0x10000)
    const flags = 1 << 5
    parseCyclingPower(view(...le16(flags), ...le16(180), ...le16(10), ...le16(65000)), crank)
    // 65000 -> 488 wraps to a 1024-unit gap; two revolutions = 120 rpm.
    const wrapped = parseCyclingPower(
      view(...le16(flags), ...le16(180), ...le16(12), ...le16(488)),
      crank,
    )
    expect(wrapped.cadence).toBe(120)
  })
})

describe('parseCsc', () => {
  it('reads wheel speed from cumulative revolutions', () => {
    const wheel = new RevolutionCounter(1024, 0x100000000)
    const flags = 0b01
    parseCsc(view(flags, ...le16(0), ...le16(0), ...le16(0)), undefined, wheel, 2.0)
    // 10 revolutions in one second at 2 m circumference = 20 m/s.
    const result = parseCsc(
      view(flags, ...le16(10), ...le16(0), ...le16(1024)),
      undefined,
      wheel,
      2.0,
    )
    expect(result.speedMs).toBeCloseTo(20, 5)
  })
})

describe('parseRsc', () => {
  it('reads speed and cadence', () => {
    const result = parseRsc(view(0x00, ...le16(256 * 4), 180))
    expect(result.speedMs).toBe(4)
    expect(result.cadence).toBe(180)
  })

  it('reads total distance past an optional stride length', () => {
    const flags = 0b11
    const result = parseRsc(
      view(flags, ...le16(256 * 3), 170, ...le16(120), 0x10, 0x27, 0x00, 0x00),
    )
    expect(result.distanceM).toBe(1000.0)
  })
})

describe('parseIndoorBikeData', () => {
  it('treats a clear "more data" bit as speed present', () => {
    // bit 0 clear => speed present; bit 2 cadence; bit 6 power
    const flags = (1 << 2) | (1 << 6)
    const result = parseIndoorBikeData(view(...le16(flags), ...le16(3000), ...le16(180), ...le16(475)))
    expect(result.speedMs).toBeCloseTo(30 / 3.6, 5)
    expect(result.cadence).toBe(90)
    expect(result.power).toBe(475)
  })

  it('omits speed when the "more data" bit is set', () => {
    const flags = 1 | (1 << 6)
    const result = parseIndoorBikeData(view(...le16(flags), ...le16(250)))
    expect(result.speedMs).toBeUndefined()
    expect(result.power).toBe(250)
  })

  it('relays heart rate carried inside the machine data', () => {
    const flags = 1 | (1 << 6) | (1 << 9)
    const result = parseIndoorBikeData(view(...le16(flags), ...le16(300), 165))
    expect(result.heartRate).toBe(165)
  })
})

describe('parseTreadmillData', () => {
  it('reads speed and incline', () => {
    const flags = 1 << 3
    const result = parseTreadmillData(view(...le16(flags), ...le16(1600), ...le16(15), ...le16(0)))
    expect(result.speedMs).toBeCloseTo(16 / 3.6, 5)
    expect(result.inclinePct).toBeCloseTo(1.5, 5)
  })
})

/**
 * The CORE fields are positional and optional: an absent one shifts every later
 * field along. A mis-ordered read yields a plausible temperature rather than an
 * error, so each flag combination is checked against a hand-built packet.
 */
describe('parseCoreTemperature', () => {
  it('reads the mandatory core temperature alone', () => {
    // flags 0x00: nothing optional present. 3782 = 37.82 °C.
    expect(parseCoreTemperature(view(0x00, ...le16(3782)))).toEqual({ coreTempC: 37.82 })
  })

  it('reads skin temperature when its flag is set', () => {
    expect(parseCoreTemperature(view(0x01, ...le16(3782), ...le16(3310)))).toEqual({
      coreTempC: 37.82,
      skinTempC: 33.1,
    })
  })

  it('skips the reserved field so later fields stay aligned', () => {
    // flags 0x22: core reserved (bit 1) + heat strain index (bit 5).
    // Without skipping the reserved 2 bytes, the HSI would be read from them.
    expect(parseCoreTemperature(view(0x22, ...le16(3782), ...le16(999), 42))).toEqual({
      coreTempC: 37.82,
      heatStrainIndex: 4.2,
    })
  })

  it('decodes quality and heart-rate-monitor state', () => {
    // flags 0x04: quality and state present. 0x23 = quality 3 (good), state 2.
    expect(parseCoreTemperature(view(0x04, ...le16(3700), 0x23))).toEqual({
      coreTempC: 37,
      coreQuality: 3,
      coreHrmState: 2,
    })
  })

  it('treats the not-available codes for quality and state as absent', () => {
    // quality 0b111 and state 0b11 both mean "not reported".
    expect(parseCoreTemperature(view(0x04, ...le16(3700), 0x37))).toEqual({ coreTempC: 37 })
  })

  it('reports an invalid quality rather than hiding it', () => {
    // Quality 0 is "invalid", which is a reading about the reading, not a gap.
    expect(parseCoreTemperature(view(0x04, ...le16(3700), 0x00))).toEqual({
      coreTempC: 37,
      coreQuality: 0,
      coreHrmState: 0,
    })
  })

  it('reads a relayed heart rate but ignores the zero that means no signal', () => {
    expect(parseCoreTemperature(view(0x10, ...le16(3700), 168))).toEqual({
      coreTempC: 37,
      heartRate: 168,
    })
    expect(parseCoreTemperature(view(0x10, ...le16(3700), 0))).toEqual({ coreTempC: 37 })
  })

  it('reads every optional field together, in spec order', () => {
    // flags 0x37 = skin | reserved | quality | HR | HSI, unit °C.
    expect(
      parseCoreTemperature(view(0x37, ...le16(3812), ...le16(3305), ...le16(0), 0x22, 172, 51)),
    ).toEqual({
      coreTempC: 38.12,
      skinTempC: 33.05,
      coreQuality: 2,
      coreHrmState: 2,
      heartRate: 172,
      heatStrainIndex: 5.1,
    })
  })

  it('converts Fahrenheit to Celsius when the unit flag is set', () => {
    // flags 0x09 = skin present, unit °F. 10000 = 100.00 °F = 37.78 °C.
    const out = parseCoreTemperature(view(0x09, ...le16(10000), ...le16(9500)))
    expect(out.coreTempC).toBeCloseTo(37.78, 2)
    expect(out.skinTempC).toBeCloseTo(35, 2)
  })

  it('omits the reading when the sensor sends the no-data sentinel', () => {
    expect(parseCoreTemperature(view(0x00, ...le16(0x7fff)))).toEqual({})
    expect(parseCoreTemperature(view(0x01, ...le16(3700), ...le16(0x7fff)))).toEqual({
      coreTempC: 37,
    })
  })

  it('does not read past a truncated packet', () => {
    // Flags claim skin and HSI, but the payload stops after the core value.
    expect(parseCoreTemperature(view(0x21, ...le16(3700)))).toEqual({ coreTempC: 37 })
  })
})
