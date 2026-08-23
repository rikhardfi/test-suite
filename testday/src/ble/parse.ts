import type { MetricUpdate } from './types'

/** Sequential little-endian reader over a notification payload. */
export class Reader {
  private offset = 0
  constructor(private readonly view: DataView) {}

  get remaining(): number {
    return this.view.byteLength - this.offset
  }

  u8(): number {
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  i8(): number {
    const v = this.view.getInt8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u24(): number {
    const a = this.view.getUint8(this.offset)
    const b = this.view.getUint8(this.offset + 1)
    const c = this.view.getUint8(this.offset + 2)
    this.offset += 3
    return a | (b << 8) | (c << 16)
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  skip(bytes: number): void {
    this.offset += bytes
  }
}

export const bit = (flags: number, n: number): boolean => (flags & (1 << n)) !== 0

/**
 * Turns the cumulative revolution counters used by CSC / cycling power into a
 * rate. Both counters and event timers wrap, so differences are taken modulo
 * their field width.
 *
 * `timeUnitsPerSecond` is 1024 for CSC and crank data, 2048 for wheel data in
 * the cycling power measurement.
 */
export class RevolutionCounter {
  private lastRevs: number | null = null
  private lastTime: number | null = null

  constructor(
    private readonly timeUnitsPerSecond: number,
    private readonly revModulo: number,
    /** Rate is held for this long before decaying to zero when coasting. */
    private readonly staleAfterS = 3,
  ) {}

  /** Returns revolutions per minute, or null until a usable pair of samples exists. */
  update(revs: number, eventTime: number): number | null {
    const prevRevs = this.lastRevs
    const prevTime = this.lastTime
    this.lastRevs = revs
    this.lastTime = eventTime
    if (prevRevs === null || prevTime === null) return null

    const dt = mod(eventTime - prevTime, 0x10000) / this.timeUnitsPerSecond
    const dRev = mod(revs - prevRevs, this.revModulo)

    // No new event: the sensor is repeating its last packet, so there is
    // nothing to divide by. A long gap means the rider stopped pedalling.
    if (dt === 0) return null
    if (dt > this.staleAfterS) return 0
    return (dRev / dt) * 60
  }
}

const mod = (n: number, m: number): number => ((n % m) + m) % m

/** Heart Rate Measurement, characteristic 0x2A37. */
export function parseHeartRate(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u8()
  const heartRate = bit(flags, 0) ? r.u16() : r.u8()
  const out: MetricUpdate = { heartRate }

  if (bit(flags, 3)) r.skip(2) // energy expended, kJ
  if (bit(flags, 4)) {
    const rr: number[] = []
    while (r.remaining >= 2) rr.push((r.u16() / 1024) * 1000)
    if (rr.length) out.rrIntervalsMs = rr
  }
  return out
}

/**
 * Cycling Power Measurement, characteristic 0x2A63. Optional fields appear in
 * flag-bit order, so every present field must be consumed to stay aligned.
 */
export function parseCyclingPower(
  view: DataView,
  crank?: RevolutionCounter,
  wheel?: RevolutionCounter,
  wheelCircumferenceM = 2.096,
): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u16()
  const out: MetricUpdate = { power: r.i16() }

  // Pedal power balance, in halves of a percent. Read rather than skipped: a
  // meter that measures one leg and doubles it reports exactly 50 forever, and
  // that is the only thing BLE will say about whether a power figure rests on
  // one leg or two.
  if (bit(flags, 0)) out.pedalBalancePct = r.u8() / 2
  if (bit(flags, 2)) r.skip(2) // accumulated torque
  if (bit(flags, 4)) {
    const revs = r.u32()
    const time = r.u16()
    const rpm = wheel?.update(revs, time)
    if (rpm != null) out.speedMs = (rpm / 60) * wheelCircumferenceM
  }
  if (bit(flags, 5)) {
    const revs = r.u16()
    const time = r.u16()
    const rpm = crank?.update(revs, time)
    if (rpm != null) out.cadence = Math.round(rpm)
  }
  return out
}

/** CSC Measurement, characteristic 0x2A5B. */
export function parseCsc(
  view: DataView,
  crank?: RevolutionCounter,
  wheel?: RevolutionCounter,
  wheelCircumferenceM = 2.096,
): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u8()
  const out: MetricUpdate = {}

  if (bit(flags, 0)) {
    const revs = r.u32()
    const time = r.u16()
    const rpm = wheel?.update(revs, time)
    if (rpm != null) out.speedMs = (rpm / 60) * wheelCircumferenceM
  }
  if (bit(flags, 1)) {
    const revs = r.u16()
    const time = r.u16()
    const rpm = crank?.update(revs, time)
    if (rpm != null) out.cadence = Math.round(rpm)
  }
  return out
}

/** RSC Measurement, characteristic 0x2A53. */
export function parseRsc(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u8()
  const out: MetricUpdate = {
    speedMs: r.u16() / 256,
    cadence: r.u8(),
  }
  if (bit(flags, 0)) r.skip(2) // instantaneous stride length
  if (bit(flags, 1)) out.distanceM = r.u32() / 10
  return out
}

/**
 * FTMS Indoor Bike Data, characteristic 0x2AD2.
 *
 * Flag bit 0 is "More Data", and its polarity is inverted relative to every
 * other bit: instantaneous speed is present when the bit is *clear*.
 */
export function parseIndoorBikeData(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u16()
  const out: MetricUpdate = {}

  if (!bit(flags, 0)) out.speedMs = (r.u16() * 0.01) / 3.6
  if (bit(flags, 1)) r.skip(2) // average speed
  if (bit(flags, 2)) out.cadence = Math.round(r.u16() * 0.5)
  if (bit(flags, 3)) r.skip(2) // average cadence
  if (bit(flags, 4)) out.distanceM = r.u24()
  if (bit(flags, 5)) out.resistance = r.i16()
  if (bit(flags, 6)) out.power = r.i16()
  if (bit(flags, 7)) r.skip(2) // average power
  if (bit(flags, 8)) r.skip(5) // expended energy
  if (bit(flags, 9)) out.heartRate = r.u8()
  return out
}

/** FTMS Treadmill Data, characteristic 0x2ACD. */
export function parseTreadmillData(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u16()
  const out: MetricUpdate = {}

  if (!bit(flags, 0)) out.speedMs = (r.u16() * 0.01) / 3.6
  if (bit(flags, 1)) r.skip(2) // average speed
  if (bit(flags, 2)) out.distanceM = r.u24()
  if (bit(flags, 3)) {
    out.inclinePct = r.i16() * 0.1
    r.skip(2) // ramp angle setting
  }
  if (bit(flags, 4)) r.skip(4) // elevation gain (positive + negative)
  if (bit(flags, 5)) r.skip(1) // instantaneous pace
  if (bit(flags, 6)) r.skip(1) // average pace
  if (bit(flags, 7)) r.skip(5) // expended energy
  if (bit(flags, 8)) out.heartRate = r.u8()
  if (bit(flags, 9)) r.skip(1) // metabolic equivalent
  if (bit(flags, 10)) r.skip(2) // elapsed time
  if (bit(flags, 11)) r.skip(2) // remaining time
  if (bit(flags, 12)) {
    r.skip(2) // force on belt
    out.power = r.i16()
  }
  return out
}

export interface FtmsFeatures {
  cadence: boolean
  powerMeasurement: boolean
  inclination: boolean
  setSpeed: boolean
  setIncline: boolean
  setResistance: boolean
  setPower: boolean
}

/** FTMS Fitness Machine Feature, characteristic 0x2ACC. */
export function parseFtmsFeatures(view: DataView): FtmsFeatures {
  const machine = view.getUint32(0, true)
  const target = view.getUint32(4, true)
  return {
    cadence: bit(machine, 1),
    inclination: bit(machine, 3),
    powerMeasurement: bit(machine, 14),
    setSpeed: bit(target, 0),
    setIncline: bit(target, 1),
    setResistance: bit(target, 2),
    setPower: bit(target, 3),
  }
}

/** Supported Power Range, characteristic 0x2AD8. */
export function parsePowerRange(view: DataView): { min: number; max: number; step: number } {
  return {
    min: view.getInt16(0, true),
    max: view.getInt16(2, true),
    step: view.getUint16(4, true),
  }
}

/** Supported Speed Range, characteristic 0x2AD4 — values are 0.01 km/h. */
export function parseSpeedRange(view: DataView): { min: number; max: number; step: number } {
  return {
    min: view.getUint16(0, true) * 0.01,
    max: view.getUint16(2, true) * 0.01,
    step: view.getUint16(4, true) * 0.01,
  }
}

/** Data quality reported alongside a CORE reading, worst to best. */
export const CORE_QUALITY = ['invalid', 'poor', 'fair', 'good', 'excellent'] as const
export type CoreQuality = (typeof CORE_QUALITY)[number]

/** Whether the CORE sensor is receiving a heart rate signal, which it uses. */
export const CORE_HRM_STATE = ['not supported', 'not receiving', 'receiving'] as const

/** Sentinel the CORE spec uses for "no valid reading right now". */
const CORE_NO_DATA = 0x7fff

/**
 * CORE Body Temperature measurement characteristic.
 *
 * Layout, little-endian, per the Core Body Temperature Service specification:
 *
 * | Field                  | Type   | Present when | Units      |
 * | ---------------------- | ------ | ------------ | ---------- |
 * | Flags                  | uint8  | always       |            |
 * | Core body temperature  | sint16 | always       | 0.01 °C/°F |
 * | Skin temperature       | sint16 | flag bit 0   | 0.01 °C/°F |
 * | Core reserved          | sint16 | flag bit 1   |            |
 * | Quality and state      | uint8  | flag bit 2   |            |
 * | Heart rate             | uint8  | flag bit 4   | bpm        |
 * | Heat strain index      | uint8  | flag bit 5   | 0.1 a.u.   |
 *
 * Flag bit 3 selects the temperature unit: 0 is °C, 1 is °F. Everything is
 * converted to °C here so nothing downstream has to carry a unit around.
 *
 * The optional fields are positional, so an absent one shifts every later
 * field. Reading them in the wrong order yields plausible numbers rather than
 * an error, which is exactly the kind of silent wrongness the tests exist for.
 */
export function parseCoreTemperature(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const flags = r.u8()
  const fahrenheit = bit(flags, 3)
  const toC = (raw: number): number =>
    fahrenheit ? ((raw / 100 - 32) * 5) / 9 : raw / 100

  const out: MetricUpdate = {}

  const core = r.i16()
  if (core !== CORE_NO_DATA) out.coreTempC = round2(toC(core))

  if (bit(flags, 0) && r.remaining >= 2) {
    const skin = r.i16()
    if (skin !== CORE_NO_DATA) out.skinTempC = round2(toC(skin))
  }

  // Present but unused: reading it is what keeps the later offsets right.
  if (bit(flags, 1) && r.remaining >= 2) r.skip(2)

  if (bit(flags, 2) && r.remaining >= 1) {
    const qualityAndState = r.u8()
    const quality = qualityAndState & 0x07
    const hrmState = (qualityAndState >> 4) & 0x03
    // 0b111 means the sensor is not reporting a quality at all.
    if (quality !== 0x07) out.coreQuality = quality
    if (hrmState !== 0x03) out.coreHrmState = hrmState
  }

  if (bit(flags, 4) && r.remaining >= 1) {
    const hr = r.u8()
    // The spec sets this to 0 when no heart rate signal is being received.
    if (hr > 0) out.heartRate = hr
  }

  if (bit(flags, 5) && r.remaining >= 1) {
    out.heatStrainIndex = r.u8() / 10
  }

  return out
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Aranet4 current readings.
 *
 * Layout, little endian: CO₂ ppm (uint16), temperature in 0.05 °C steps
 * (uint16), pressure in 0.1 hPa steps (uint16), humidity percent (uint8),
 * battery percent (uint8), status (uint8).
 *
 * A CO₂ value of 0 is the device saying it has not measured yet, typically in
 * the first minute after power-on. It is dropped rather than recorded, because
 * a recorded zero would read as clean air.
 */
export function parseAranet(view: DataView): MetricUpdate {
  const r = new Reader(view)
  const out: MetricUpdate = {}
  if (view.byteLength < 9) return out

  const co2 = r.u16()
  const tempRaw = r.u16()
  const pressureRaw = r.u16()
  const humidity = r.u8()

  if (co2 > 0 && co2 < 0xffff) out.co2Ppm = co2
  if (tempRaw !== 0xffff) out.ambientTempC = tempRaw * 0.05
  if (pressureRaw !== 0xffff) out.pressureHpa = pressureRaw * 0.1
  if (humidity <= 100) out.humidityPct = humidity

  return out
}
