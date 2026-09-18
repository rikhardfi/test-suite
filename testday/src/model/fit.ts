import type { Lap, SessionRecord, Sample } from './session'
import type { Protocol } from './protocol'
import { computeKcal } from './vo2'
import { max, mean } from './metrics'

/**
 * A FIT encoder, written here rather than taken from a package.
 *
 * Why FIT at all: TCX has nowhere to put blood lactate, Borg RPE, the
 * commanded target, a core temperature or an estimated oxygen cost, so every
 * one of them used to stop at the CSV. FIT has developer data fields, which are
 * typed, named and carry their own units, and which conforming readers pass
 * through instead of discarding. It also has a real `grade` field, real lap
 * messages and a session summary, so a protocol's step structure survives an
 * export for the first time.
 *
 * Why written by hand: Garmin's SDK and the community libraries decode. None of
 * them encode, and this app has almost no dependencies, makes no network
 * requests, and must not need an npm install to work on the morning of a test.
 *
 * What the tests can and cannot prove: `fit.test.ts` decodes what is written
 * here with a reader that shares none of this file's tables, which catches a
 * definition that disagrees with the data behind it. It cannot tell whether a
 * field number is the one Garmin means by that name, because both sides would
 * be wrong together.
 *
 * That part was checked separately, against `fitdecode` and the official
 * profile, and it found two bugs neither the encoder nor its own reader could
 * see: `developer_data_id` had its field numbers one apart, which made every
 * developer field unreadable and the file rejected outright, and scaled fields
 * applied their offset after the scale instead of before, which turned an
 * altitude of 0 m into -400 m. Both now have regression tests. Re-run that
 * check against a real decoder whenever a message or field number changes here;
 * the unit tests alone will not catch this class of mistake.
 *
 * Everything here is pure and returns bytes.
 */

// --- base types -------------------------------------------------------------

/** The high bit marks a type whose byte order matters. */
const BASE = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  float32: 0x88,
  uint8z: 0x0a,
  uint16z: 0x8b,
  uint32z: 0x8c,
  byte: 0x0d,
} as const

type BaseType = (typeof BASE)[keyof typeof BASE]

const SIZE_OF: Record<number, number> = {
  [BASE.enum]: 1,
  [BASE.sint8]: 1,
  [BASE.uint8]: 1,
  [BASE.uint8z]: 1,
  [BASE.byte]: 1,
  [BASE.string]: 1,
  [BASE.sint16]: 2,
  [BASE.uint16]: 2,
  [BASE.uint16z]: 2,
  [BASE.sint32]: 4,
  [BASE.uint32]: 4,
  [BASE.uint32z]: 4,
  [BASE.float32]: 4,
}

/**
 * Every base type has a reserved value meaning "not present". Writing the
 * invalid value is how a field is left blank, and it is not the same as writing
 * a zero: a zero is a measurement.
 */
const INVALID: Record<number, number> = {
  [BASE.enum]: 0xff,
  [BASE.sint8]: 0x7f,
  [BASE.uint8]: 0xff,
  [BASE.uint8z]: 0,
  [BASE.byte]: 0xff,
  [BASE.sint16]: 0x7fff,
  [BASE.uint16]: 0xffff,
  [BASE.uint16z]: 0,
  [BASE.sint32]: 0x7fffffff,
  [BASE.uint32]: 0xffffffff,
  [BASE.uint32z]: 0,
  [BASE.float32]: 0xffffffff,
}

// --- global message numbers -------------------------------------------------

const MESG = {
  fileId: 0,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  deviceInfo: 23,
  activity: 34,
  fileCreator: 49,
  fieldDescription: 206,
  developerDataId: 207,
} as const

/** Seconds between the unix epoch and the FIT epoch, 1989-12-31T00:00:00Z. */
const FIT_EPOCH_OFFSET = 631065600

const toFitTime = (unixMs: number): number =>
  Math.max(0, Math.round(unixMs / 1000) - FIT_EPOCH_OFFSET)

/** 255 is the manufacturer id reserved for development, which is what this is. */
const MANUFACTURER_DEVELOPMENT = 255

/** This file declares one developer, so every developer field carries index 0. */
const DEVELOPER_DATA_INDEX = 0

// --- CRC --------------------------------------------------------------------

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
]

/** The CRC-16 variant the FIT specification defines, one byte at a time. */
export function fitCrc(bytes: Uint8Array, seed = 0): number {
  let crc = seed
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf]
    crc = (crc >> 4) & 0x0fff
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]

    tmp = CRC_TABLE[crc & 0xf]
    crc = (crc >> 4) & 0x0fff
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]
  }
  return crc & 0xffff
}

// --- byte buffer ------------------------------------------------------------

class ByteWriter {
  private buffer = new Uint8Array(1024)
  private length = 0

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return
    let size = this.buffer.length * 2
    while (size < this.length + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }

  u8(value: number): void {
    this.ensure(1)
    this.buffer[this.length++] = value & 0xff
  }

  /** Little endian throughout; the file header declares that architecture. */
  u16(value: number): void {
    this.u8(value)
    this.u8(value >> 8)
  }

  u32(value: number): void {
    this.u16(value)
    this.u16(value >>> 16)
  }

  f32(value: number): void {
    const view = new DataView(new ArrayBuffer(4))
    view.setFloat32(0, value, true)
    for (let i = 0; i < 4; i++) this.u8(view.getUint8(i))
  }

  bytes(values: Uint8Array): void {
    this.ensure(values.length)
    this.buffer.set(values, this.length)
    this.length += values.length
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }

  get size(): number {
    return this.length
  }
}

// --- field definitions ------------------------------------------------------

interface FieldSpec {
  num: number
  type: BaseType
  /** Stored value is `Math.round(value * scale + offset)`. */
  scale?: number
  offset?: number
  /** Fixed byte length, for strings. */
  size?: number
}

type FieldValues = Record<number, number | string | undefined | null>

const sizeOf = (spec: FieldSpec): number => spec.size ?? SIZE_OF[spec.type]

function writeValue(out: ByteWriter, spec: FieldSpec, raw: number | string | undefined | null): void {
  const size = sizeOf(spec)

  if (spec.type === BASE.string) {
    const text = typeof raw === 'string' ? raw : ''
    const encoded = new TextEncoder().encode(text).subarray(0, size - 1)
    const padded = new Uint8Array(size)
    padded.set(encoded)
    out.bytes(padded)
    return
  }

  if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw)) {
    writeScalar(out, spec.type, INVALID[spec.type])
    return
  }

  if (spec.type === BASE.float32) {
    out.f32(raw)
    return
  }
  // FIT reads a field back as `stored / scale - offset`, so the offset goes on
  // before the scale, not after. The other way round an altitude of 0 m is
  // stored as 500 and reads back as -400 m, which is a plausible enough number
  // to survive into an analysis unnoticed.
  const scaled = Math.round((raw + (spec.offset ?? 0)) * (spec.scale ?? 1))
  writeScalar(out, spec.type, clampToType(spec.type, scaled))
}

function writeScalar(out: ByteWriter, type: BaseType, value: number): void {
  switch (SIZE_OF[type]) {
    case 1:
      out.u8(value)
      return
    case 2:
      out.u16(value)
      return
    default:
      if (type === BASE.float32) {
        out.f32(value)
        return
      }
      out.u32(value)
  }
}

/**
 * A value that will not fit its field becomes the invalid value rather than
 * wrapping. A wrapped number reads as a real measurement and is far worse than
 * a gap: a 70000 W spike silently becoming 4464 W is exactly the sort of thing
 * that survives into an analysis.
 */
function clampToType(type: BaseType, value: number): number {
  const ranges: Record<number, [number, number]> = {
    [BASE.enum]: [0, 0xfe],
    [BASE.sint8]: [-0x80, 0x7e],
    [BASE.uint8]: [0, 0xfe],
    [BASE.uint8z]: [1, 0xff],
    [BASE.byte]: [0, 0xfe],
    [BASE.sint16]: [-0x8000, 0x7ffe],
    [BASE.uint16]: [0, 0xfffe],
    [BASE.uint16z]: [1, 0xffff],
    [BASE.sint32]: [-0x80000000, 0x7ffffffe],
    [BASE.uint32]: [0, 0xfffffffe],
    [BASE.uint32z]: [1, 0xffffffff],
  }
  const range = ranges[type]
  if (!range) return value
  if (value < range[0] || value > range[1]) return INVALID[type]
  return value
}

// --- developer fields -------------------------------------------------------

/**
 * The fields FIT has no standard home for. Each is declared in the file with
 * its name, units and type, so a reader that has never heard of this app still
 * knows what it is looking at and what the number means.
 *
 * Adding a channel is one entry here plus one line in `recordDevValues`.
 */
interface DevField {
  num: number
  name: string
  units: string
  type: BaseType
  /** Which message it hangs off. */
  on: 'record' | 'lap'
}

const DEV_FIELDS: readonly DevField[] = [
  { num: 0, name: 'target_power', units: 'watts', type: BASE.uint16, on: 'record' },
  { num: 1, name: 'target_speed', units: 'kph', type: BASE.float32, on: 'record' },
  { num: 2, name: 'target_grade', units: '%', type: BASE.float32, on: 'record' },
  { num: 3, name: 'vo2_estimate', units: 'mL/kg/min', type: BASE.float32, on: 'record' },
  // Recorded beside the estimate, because a number without its equation is
  // indistinguishable from a measured VO2 once it leaves this app.
  { num: 4, name: 'vo2_method', units: '', type: BASE.string, on: 'record' },
  { num: 5, name: 'core_temperature', units: 'degC', type: BASE.float32, on: 'record' },
  { num: 6, name: 'skin_temperature', units: 'degC', type: BASE.float32, on: 'record' },
  { num: 7, name: 'heat_strain_index', units: '', type: BASE.float32, on: 'record' },
  { num: 8, name: 'core_quality', units: '', type: BASE.uint8, on: 'record' },
  { num: 9, name: 'resistance', units: '', type: BASE.uint8, on: 'record' },
  // 0 measured by the machine, 1 assumed from what the machine was commanded.
  { num: 10, name: 'grade_is_commanded', units: '', type: BASE.uint8, on: 'record' },
  { num: 11, name: 'distance_is_integrated', units: '', type: BASE.uint8, on: 'record' },
  { num: 12, name: 'blood_lactate', units: 'mmol/L', type: BASE.float32, on: 'lap' },
  { num: 13, name: 'rpe_borg', units: '', type: BASE.uint8, on: 'lap' },
  { num: 14, name: 'step_target', units: '', type: BASE.string, on: 'lap' },
  // Both power traces and the arithmetic between them. A reader who has never
  // heard of this app gets the athlete's power in the standard `power` field
  // and everything that qualifies it here, rather than a corrected number
  // presented as if it had been measured.
  { num: 15, name: 'power_secondary', units: 'watts', type: BASE.uint16, on: 'record' },
  { num: 16, name: 'commanded_power', units: 'watts', type: BASE.uint16, on: 'record' },
  { num: 17, name: 'power_match_factor', units: '', type: BASE.float32, on: 'record' },
  // 1 while the reference meter was missing and the last factor was held.
  { num: 18, name: 'power_match_held', units: '', type: BASE.uint8, on: 'record' },
]

/** Strings need a fixed width in a definition message. */
const DEV_STRING_SIZE = 24

const devSpec = (field: DevField): FieldSpec => ({
  num: field.num,
  type: field.type,
  size: field.type === BASE.string ? DEV_STRING_SIZE : undefined,
})

// --- the encoder ------------------------------------------------------------

/** Local message types. Fixed, since there are fewer kinds than the 16 available. */
const LOCAL = {
  fileId: 0,
  fileCreator: 1,
  developerDataId: 2,
  fieldDescription: 3,
  sport: 4,
  event: 5,
  record: 6,
  lap: 7,
  session: 8,
  activity: 9,
} as const

class FitEncoder {
  private readonly out = new ByteWriter()
  /** Field layouts by local type, so a data message matches its definition. */
  private readonly layouts = new Map<number, { fields: FieldSpec[]; dev: FieldSpec[] }>()

  define(
    localType: number,
    globalNum: number,
    fields: FieldSpec[],
    dev: { spec: FieldSpec; index: number }[] = [],
  ): void {
    this.layouts.set(localType, { fields, dev: dev.map((d) => d.spec) })

    // Bit 6 marks a definition, bit 5 says developer fields follow.
    this.out.u8(0x40 | (dev.length ? 0x20 : 0) | (localType & 0x0f))
    this.out.u8(0) // reserved
    this.out.u8(0) // architecture: little endian
    this.out.u16(globalNum)
    this.out.u8(fields.length)
    for (const field of fields) {
      this.out.u8(field.num)
      this.out.u8(sizeOf(field))
      this.out.u8(field.type)
    }
    if (dev.length) {
      this.out.u8(dev.length)
      for (const { spec, index } of dev) {
        this.out.u8(spec.num)
        this.out.u8(sizeOf(spec))
        this.out.u8(index)
      }
    }
  }

  data(localType: number, values: FieldValues, devValues: FieldValues = {}): void {
    const layout = this.layouts.get(localType)
    if (!layout) throw new Error(`FIT: local message type ${localType} used before it was defined`)
    this.out.u8(localType & 0x0f)
    for (const field of layout.fields) writeValue(this.out, field, values[field.num])
    for (const field of layout.dev) writeValue(this.out, field, devValues[field.num])
  }

  /** Wraps the data records in a header and a trailing CRC. */
  finish(): Uint8Array {
    const body = this.out.toUint8Array()

    const header = new ByteWriter()
    header.u8(14)
    header.u8(0x20) // protocol version 2.0
    header.u16(2140) // profile version 21.40
    header.u32(body.length)
    header.bytes(new TextEncoder().encode('.FIT'))
    const headerBytes = header.toUint8Array()
    header.u16(fitCrc(headerBytes))

    const file = new ByteWriter()
    file.bytes(header.toUint8Array())
    file.bytes(body)
    // The trailing CRC covers the header and the data records together.
    file.u16(fitCrc(file.toUint8Array()))
    return file.toUint8Array()
  }
}

// --- laps -------------------------------------------------------------------

/**
 * A lap per protocol step, cut where the step actually changed.
 *
 * Grouped by runs of consecutive samples rather than by step index, so a step
 * the operator jumped back to becomes a second lap instead of being merged into
 * the first. What the file describes is what happened, not what was planned.
 */
export interface FitLap {
  stepIndex: number
  samples: Sample[]
  startS: number
  endS: number
}

export function fitLaps(samples: readonly Sample[]): FitLap[] {
  const laps: FitLap[] = []
  for (const sample of samples) {
    const current = laps[laps.length - 1]
    if (current && current.stepIndex === sample.stepIndex) {
      current.samples.push(sample)
      current.endS = sample.t
      continue
    }
    laps.push({ stepIndex: sample.stepIndex, samples: [sample], startS: sample.t, endS: sample.t })
  }
  return laps
}

/**
 * The altitude trace, one metre value per sample, relative to the start.
 *
 * A treadmill has no altimeter, so vertical metres only exist as the gradient
 * integrated over the distance covered. Computing the whole trace up front,
 * rather than accumulating it inside the record loop, is what lets the lap and
 * session summaries report an ascent that agrees with the altitude field they
 * summarise instead of being a second estimate arrived at a different way.
 */
export function fitAltitudes(samples: readonly Sample[]): Map<Sample, number> {
  const altitudes = new Map<Sample, number>()
  let climbM = 0
  let previousDistance = 0
  for (const sample of samples) {
    const distance = sample.distanceM ?? previousDistance
    if (sample.inclinePct != null && distance > previousDistance) {
      climbM += (distance - previousDistance) * (sample.inclinePct / 100)
    }
    previousDistance = distance
    altitudes.set(sample, climbM)
  }
  return altitudes
}

/**
 * Vertical metres up and down over a stretch of the trace: the positive and
 * negative parts of the change between consecutive samples, both reported as
 * positive numbers, which is how FIT stores them.
 *
 * `from` is the altitude at the sample before the stretch, so a lap is charged
 * for the metres climbed across the boundary into it and the laps add up to
 * the session rather than losing a step each.
 */
export function climbOver(
  samples: readonly Sample[],
  altitudes: Map<Sample, number>,
  from = 0,
): { ascentM: number; descentM: number } {
  let ascentM = 0
  let descentM = 0
  let previous = from
  for (const sample of samples) {
    const altitude = altitudes.get(sample)
    if (altitude == null) continue
    const change = altitude - previous
    if (change > 0) ascentM += change
    else descentM -= change
    previous = altitude
  }
  return { ascentM, descentM }
}

const pluck = (samples: readonly Sample[], key: keyof Sample): number[] => {
  const out: number[] = []
  for (const sample of samples) {
    const value = sample[key]
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  }
  return out
}

/**
 * Energy cost over a set of 1 Hz samples.
 *
 * Uses the recorded oxygen estimate where there is one, since that is the same
 * number the dashboard showed. Where there is not, it falls back to mechanical
 * work at a gross efficiency of 22%, which is the same assumption the ACSM
 * cycling equation embeds, so the two routes do not disagree with each other.
 */
export function kcalOver(samples: readonly Sample[], massKg: number): number {
  let kcal = 0
  let usedPower = false
  for (const sample of samples) {
    if (sample.vo2Est != null) {
      kcal += computeKcal(sample.vo2Est, massKg, 1 / 60)
    } else if (sample.power != null) {
      usedPower = true
      kcal += (sample.power * 1) / 1000 / 4.184 / 0.22
    }
  }
  void usedPower
  return kcal
}

// --- the writer -------------------------------------------------------------

export interface FitOptions {
  /** Written into `file_id` and `file_creator`, so a file says what made it. */
  appName?: string
  appVersion?: string
  /** Step labels, so each lap can carry the target it was run at. */
  laps?: readonly Lap[]
  protocol?: Protocol
}

/** FIT sport enum: 1 running, 2 cycling. Sub-sport: 1 treadmill, 6 indoor cycling. */
const SPORT = { run: 1, bike: 2 } as const
const SUB_SPORT = { run: 1, bike: 6 } as const

export function sessionToFit(session: SessionRecord, options: FitOptions = {}): Uint8Array {
  const encoder = new FitEncoder()
  const appName = options.appName ?? 'testday'
  const appVersion = options.appVersion ?? '0.1.0'
  const startTime = toFitTime(session.startedAt)
  const samples = session.samples
  const laps = fitLaps(samples)
  const altitudes = fitAltitudes(samples)
  // Without a gradient anywhere there is no vertical information at all, and
  // the ascent fields are left absent rather than written as a zero. A zero
  // here is a measurement: it says the athlete ran flat.
  const hasGradient = samples.some((sample) => sample.inclinePct != null)
  const massKg = session.athlete.massKg || 75
  const sport = SPORT[session.sport]
  const subSport = SUB_SPORT[session.sport]

  const timeAt = (t: number): number => toFitTime(session.startedAt + t * 1000)
  const lastT = samples.length ? samples[samples.length - 1].t : 0
  // Sampling starts at t = 0, so the elapsed time is one interval longer than
  // the last timestamp. The old TCX writer got this wrong in the other
  // direction and declared 899 s for 900 recorded seconds.
  const elapsedS = samples.length ? lastT + 1 : 0

  // --- identity ---
  encoder.define(LOCAL.fileId, MESG.fileId, [
    { num: 0, type: BASE.enum },
    { num: 1, type: BASE.uint16 },
    { num: 2, type: BASE.uint16 },
    { num: 3, type: BASE.uint32z },
    { num: 4, type: BASE.uint32 },
    { num: 8, type: BASE.string, size: 16 },
  ])
  encoder.data(LOCAL.fileId, {
    0: 4, // activity file
    1: MANUFACTURER_DEVELOPMENT,
    2: 1,
    3: 1,
    4: startTime,
    8: appName,
  })

  encoder.define(LOCAL.fileCreator, MESG.fileCreator, [
    { num: 0, type: BASE.uint16 },
    { num: 1, type: BASE.uint8 },
  ])
  encoder.data(LOCAL.fileCreator, { 0: versionNumber(appVersion), 1: 1 })

  // --- developer field declarations ---
  const usedDev = DEV_FIELDS.filter((field) => isFieldUsed(field, session, options.laps))

  if (usedDev.length) {
    // developer_data_id: manufacturer_id is 2 and developer_data_index is 3.
    // Getting these one apart registers the index under the manufacturer's
    // value, and every field_description that follows then refers to an index
    // that was never declared. A decoder is entitled to reject the whole file
    // for it, and the strict ones do.
    encoder.define(LOCAL.developerDataId, MESG.developerDataId, [
      { num: 2, type: BASE.uint16 }, // manufacturer_id
      { num: 3, type: BASE.uint8 }, // developer_data_index
      { num: 4, type: BASE.uint32 }, // application_version
    ])
    encoder.data(LOCAL.developerDataId, {
      2: MANUFACTURER_DEVELOPMENT,
      3: DEVELOPER_DATA_INDEX,
      4: versionNumber(appVersion),
    })

    encoder.define(LOCAL.fieldDescription, MESG.fieldDescription, [
      { num: 0, type: BASE.uint8 },
      { num: 1, type: BASE.uint8 },
      { num: 2, type: BASE.uint8 },
      { num: 3, type: BASE.string, size: 32 },
      { num: 8, type: BASE.string, size: 16 },
      { num: 14, type: BASE.uint16 },
    ])
    for (const field of usedDev) {
      encoder.data(LOCAL.fieldDescription, {
        0: DEVELOPER_DATA_INDEX,
        1: field.num,
        2: field.type,
        3: field.name,
        8: field.units,
        14: field.on === 'record' ? MESG.record : MESG.lap,
      })
    }
  }

  // --- sport ---
  encoder.define(LOCAL.sport, MESG.sport, [
    { num: 0, type: BASE.enum },
    { num: 1, type: BASE.enum },
    { num: 3, type: BASE.string, size: 24 },
  ])
  encoder.data(LOCAL.sport, { 0: sport, 1: subSport, 3: session.protocolName })

  // --- timer start ---
  encoder.define(LOCAL.event, MESG.event, [
    { num: 253, type: BASE.uint32 },
    { num: 0, type: BASE.enum },
    { num: 1, type: BASE.enum },
  ])
  encoder.data(LOCAL.event, { 253: startTime, 0: 0, 1: 0 }) // timer, start

  // --- records ---
  const recordDev = usedDev.filter((f) => f.on === 'record')
  encoder.define(
    LOCAL.record,
    MESG.record,
    [
      { num: 253, type: BASE.uint32 },
      { num: 3, type: BASE.uint8 }, // heart_rate, bpm
      { num: 4, type: BASE.uint8 }, // cadence, rpm
      { num: 5, type: BASE.uint32, scale: 100 }, // distance, m
      { num: 6, type: BASE.uint16, scale: 1000 }, // speed, m/s
      { num: 7, type: BASE.uint16 }, // power, watts
      { num: 9, type: BASE.sint16, scale: 100 }, // grade, %
      { num: 2, type: BASE.uint16, scale: 5, offset: 500 }, // altitude, m
    ],
    recordDev.map((field) => ({ spec: devSpec(field), index: DEVELOPER_DATA_INDEX })),
  )

  for (const sample of samples) {
    encoder.data(
      LOCAL.record,
      {
        253: timeAt(sample.t),
        3: sample.heartRate,
        4: sample.cadence,
        5: sample.distanceM,
        6: sample.speedMs,
        7: sample.power,
        9: sample.inclinePct,
        2: altitudes.get(sample),
      },
      recordDevValues(sample, recordDev),
    )
  }

  // --- laps ---
  const lapDev = usedDev.filter((f) => f.on === 'lap')
  encoder.define(
    LOCAL.lap,
    MESG.lap,
    [
      { num: 253, type: BASE.uint32 },
      { num: 254, type: BASE.uint16 },
      { num: 2, type: BASE.uint32 }, // start_time
      { num: 7, type: BASE.uint32, scale: 1000 }, // total_elapsed_time, s
      { num: 8, type: BASE.uint32, scale: 1000 }, // total_timer_time, s
      { num: 9, type: BASE.uint32, scale: 100 }, // total_distance, m
      { num: 11, type: BASE.uint16 }, // total_calories, kcal
      { num: 13, type: BASE.uint16, scale: 1000 }, // avg_speed
      { num: 14, type: BASE.uint16, scale: 1000 }, // max_speed
      { num: 15, type: BASE.uint8 }, // avg_heart_rate
      { num: 16, type: BASE.uint8 }, // max_heart_rate
      { num: 17, type: BASE.uint8 }, // avg_cadence
      { num: 19, type: BASE.uint16 }, // avg_power
      { num: 20, type: BASE.uint16 }, // max_power
      // The lap numbers them one lower than the session does: 21 and 22 here,
      // 22 and 23 there, because the session carries an avg_power at 20 and a
      // max_power at 21 where the lap has them at 19 and 20. Reading these off
      // the session's row is exactly the mistake `verify_fit.py` exists to
      // catch, and it would decode as a plausible power rather than as junk.
      { num: 21, type: BASE.uint16 }, // total_ascent, m
      { num: 22, type: BASE.uint16 }, // total_descent, m
      { num: 25, type: BASE.enum }, // sport
      { num: 0, type: BASE.enum }, // event
      { num: 1, type: BASE.enum }, // event_type
    ],
    lapDev.map((field) => ({ spec: devSpec(field), index: DEVELOPER_DATA_INDEX })),
  )

  // Carried across the laps so each is charged for the climb on the interval
  // into it, and the lap ascents sum to the session's.
  let previousAltitude = 0
  laps.forEach((lap, index) => {
    const power = pluck(lap.samples, 'power')
    const hr = pluck(lap.samples, 'heartRate')
    const cadence = pluck(lap.samples, 'cadence')
    const speed = pluck(lap.samples, 'speedMs')
    const distances = pluck(lap.samples, 'distanceM')
    const lapDistance = distances.length ? distances[distances.length - 1] - distances[0] : undefined
    const lactate = session.lactate.find((l) => l.stepIndex === lap.stepIndex && !l.removed)
    const duration = lap.endS - lap.startS + 1
    const climb = climbOver(lap.samples, altitudes, previousAltitude)
    previousAltitude = altitudes.get(lap.samples[lap.samples.length - 1]) ?? previousAltitude

    encoder.data(
      LOCAL.lap,
      {
        253: timeAt(lap.endS),
        254: index,
        2: timeAt(lap.startS),
        7: duration,
        8: duration,
        9: lapDistance,
        11: Math.round(kcalOver(lap.samples, massKg)),
        13: speed.length ? mean(speed) : undefined,
        14: speed.length ? max(speed) : undefined,
        15: hr.length ? Math.round(mean(hr)) : undefined,
        16: hr.length ? Math.round(max(hr)) : undefined,
        17: cadence.length ? Math.round(mean(cadence)) : undefined,
        19: power.length ? Math.round(mean(power)) : undefined,
        20: power.length ? Math.round(max(power)) : undefined,
        21: hasGradient ? Math.round(climb.ascentM) : undefined,
        22: hasGradient ? Math.round(climb.descentM) : undefined,
        25: sport,
        0: 9, // lap
        1: 1, // stop
      },
      {
        12: lactate?.mmol,
        13: lactate?.rpe,
        14: options.laps?.[lap.stepIndex]?.target,
      },
    )
  })

  // --- timer stop ---
  encoder.data(LOCAL.event, { 253: timeAt(lastT), 0: 0, 1: 4 }) // timer, stop_all

  // --- session ---
  const allPower = pluck(samples, 'power')
  const allHr = pluck(samples, 'heartRate')
  const allCadence = pluck(samples, 'cadence')
  const allSpeed = pluck(samples, 'speedMs')
  const allDistance = pluck(samples, 'distanceM')

  encoder.define(LOCAL.session, MESG.session, [
    { num: 253, type: BASE.uint32 },
    { num: 254, type: BASE.uint16 },
    { num: 2, type: BASE.uint32 },
    { num: 5, type: BASE.enum },
    { num: 6, type: BASE.enum },
    { num: 7, type: BASE.uint32, scale: 1000 },
    { num: 8, type: BASE.uint32, scale: 1000 },
    { num: 9, type: BASE.uint32, scale: 100 },
    { num: 11, type: BASE.uint16 },
    { num: 14, type: BASE.uint16, scale: 1000 },
    { num: 15, type: BASE.uint16, scale: 1000 },
    { num: 16, type: BASE.uint8 },
    { num: 17, type: BASE.uint8 },
    { num: 18, type: BASE.uint8 },
    { num: 20, type: BASE.uint16 }, // avg_power
    { num: 21, type: BASE.uint16 }, // max_power
    { num: 22, type: BASE.uint16 }, // total_ascent, m
    { num: 23, type: BASE.uint16 }, // total_descent, m
    { num: 25, type: BASE.uint16 },
    { num: 26, type: BASE.uint16 },
    { num: 0, type: BASE.enum },
    { num: 1, type: BASE.enum },
  ])
  const totalClimb = climbOver(samples, altitudes)

  encoder.data(LOCAL.session, {
    253: timeAt(lastT),
    254: 0,
    2: startTime,
    5: sport,
    6: subSport,
    7: elapsedS,
    8: elapsedS,
    9: allDistance.length ? allDistance[allDistance.length - 1] - allDistance[0] : undefined,
    11: Math.round(kcalOver(samples, massKg)),
    14: allSpeed.length ? mean(allSpeed) : undefined,
    15: allSpeed.length ? max(allSpeed) : undefined,
    16: allHr.length ? Math.round(mean(allHr)) : undefined,
    17: allHr.length ? Math.round(max(allHr)) : undefined,
    18: allCadence.length ? Math.round(mean(allCadence)) : undefined,
    20: allPower.length ? Math.round(mean(allPower)) : undefined,
    21: allPower.length ? Math.round(max(allPower)) : undefined,
    22: hasGradient ? Math.round(totalClimb.ascentM) : undefined,
    23: hasGradient ? Math.round(totalClimb.descentM) : undefined,
    25: 0,
    26: laps.length,
    0: 8, // session
    1: 1, // stop
  })

  // --- activity ---
  encoder.define(LOCAL.activity, MESG.activity, [
    { num: 253, type: BASE.uint32 },
    { num: 0, type: BASE.uint32, scale: 1000 },
    { num: 1, type: BASE.uint16 },
    { num: 2, type: BASE.enum },
    { num: 3, type: BASE.enum },
    { num: 4, type: BASE.enum },
  ])
  encoder.data(LOCAL.activity, {
    253: timeAt(lastT),
    0: elapsedS,
    1: 1,
    2: 0, // manual
    3: 26, // activity
    4: 1, // stop
  })

  return encoder.finish()
}

/** Only fields with something to say are declared, which keeps files small. */
function isFieldUsed(field: DevField, session: SessionRecord, laps?: readonly Lap[]): boolean {
  if (field.on === 'lap') {
    if (field.num === 14) return !!laps?.length
    return session.lactate.some((l) =>
      field.num === 12 ? !l.removed : !l.removed && l.rpe != null,
    )
  }
  // The two provenance flags are only ever set on the sample when they are
  // true, so keying their presence off the flag itself would mean "measured"
  // and "this build did not record provenance" looked identical in the file.
  // They are declared whenever the value they qualify exists, and written as
  // an explicit 0 or 1.
  if (field.num === 10) return session.samples.some((sample) => sample.inclinePct != null)
  if (field.num === 11) return session.samples.some((sample) => sample.distanceM != null)
  // Same reasoning as those two: the hold flag is only ever set when true, so
  // it is declared whenever a correction was running at all and written as an
  // explicit 0 or 1. Otherwise "not held" and "not recorded" look identical.
  if (field.num === 18)
    return session.samples.some((sample) => sample.powerMatchFactor != null)

  const key = RECORD_DEV_KEYS[field.num]
  if (!key) return false
  return session.samples.some((sample) => sample[key] != null)
}

/** Which `Sample` property backs each record-level developer field. */
const RECORD_DEV_KEYS: Record<number, keyof Sample | undefined> = {
  0: 'targetPower',
  1: 'targetKph',
  2: 'targetInclinePct',
  3: 'vo2Est',
  4: 'vo2Method',
  5: 'coreTempC',
  6: 'skinTempC',
  7: 'heatStrainIndex',
  8: 'coreQuality',
  9: 'resistance',
  10: 'inclineFromTarget',
  11: 'distanceIntegrated',
  15: 'powerSecondaryW',
  16: 'commandedPower',
  17: 'powerMatchFactor',
  18: 'powerMatchHeld',
}

function recordDevValues(sample: Sample, fields: readonly DevField[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    const key = RECORD_DEV_KEYS[field.num]
    if (!key) continue
    const value = sample[key]
    // The two flags are booleans on the sample and a 0/1 in the file, because
    // FIT has no boolean and an absent flag has to mean "no" rather than
    // "unknown" for a field that is only ever set when true.
    if (field.num === 10 || field.num === 11 || field.num === 18)
      values[field.num] = value === true ? 1 : 0
    else if (typeof value === 'string') values[field.num] = value
    else if (typeof value === 'number') values[field.num] = value
  }
  return values
}

/** "0.1.0" becomes 10, the way FIT stores a two-decimal version. */
function versionNumber(version: string): number {
  const [major = '0', minor = '0'] = version.split('.')
  return Number(major) * 100 + Number(minor)
}

export function fitFilename(session: SessionRecord): string {
  const date = new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const slug = session.protocolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${date}_${slug || 'test'}.fit`
}
