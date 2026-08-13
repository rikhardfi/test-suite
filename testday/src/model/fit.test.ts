import { describe, expect, it } from 'vitest'
import { fitCrc, fitLaps, kcalOver, sessionToFit } from './fit'
import { DEFAULT_ATHLETE, makeProtocol } from './protocol'
import { lapsFromSamples, type Sample, type SessionRecord } from './session'

/**
 * A generic FIT reader, written here rather than imported.
 *
 * It knows nothing about what the encoder meant to write: it walks definition
 * and data messages the way the specification says to, which is the only way
 * this test can catch a definition that disagrees with the data behind it. A
 * reader that shared the encoder's tables would agree with any bug it had.
 *
 * What it cannot check is whether a field number is the one Garmin means by
 * that name. That needs an independent tool and a real file, and is a manual
 * step, not a unit test.
 */

interface DecodedMessage {
  globalNum: number
  fields: Record<number, number | string>
  dev: Record<number, number | string>
}

interface DecodedFile {
  protocolVersion: number
  dataSize: number
  messages: DecodedMessage[]
  crcValid: boolean
  headerCrcValid: boolean
}

const SIZE_OF: Record<number, number> = {
  0x00: 1, 0x01: 1, 0x02: 1, 0x0a: 1, 0x0d: 1, 0x07: 1,
  0x83: 2, 0x84: 2, 0x8b: 2,
  0x85: 4, 0x86: 4, 0x8c: 4, 0x88: 4,
}

function decodeFit(bytes: Uint8Array): DecodedFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerSize = view.getUint8(0)
  const protocolVersion = view.getUint8(1)
  const dataSize = view.getUint32(4, true)
  const magic = new TextDecoder().decode(bytes.subarray(8, 12))
  if (magic !== '.FIT') throw new Error(`not a FIT file: ${magic}`)

  const headerCrcValid =
    headerSize < 14 || view.getUint16(12, true) === fitCrc(bytes.subarray(0, 12))

  const end = headerSize + dataSize
  const fileCrc = view.getUint16(end, true)
  const crcValid = fileCrc === fitCrc(bytes.subarray(0, end))

  const definitions = new Map<
    number,
    {
      globalNum: number
      fields: { num: number; size: number; type: number }[]
      dev: { num: number; size: number; index: number }[]
    }
  >()
  const messages: DecodedMessage[] = []
  let at = headerSize

  const readField = (offset: number, size: number, type: number): number | string => {
    if (type === 0x07) {
      const raw = bytes.subarray(offset, offset + size)
      const zero = raw.indexOf(0)
      return new TextDecoder().decode(zero === -1 ? raw : raw.subarray(0, zero))
    }
    switch (type) {
      case 0x00:
      case 0x02:
      case 0x0a:
      case 0x0d:
        return view.getUint8(offset)
      case 0x01:
        return view.getInt8(offset)
      case 0x83:
        return view.getInt16(offset, true)
      case 0x84:
      case 0x8b:
        return view.getUint16(offset, true)
      case 0x85:
        return view.getInt32(offset, true)
      case 0x86:
      case 0x8c:
        return view.getUint32(offset, true)
      case 0x88:
        return view.getFloat32(offset, true)
      default:
        throw new Error(`unhandled base type 0x${type.toString(16)}`)
    }
  }

  while (at < end) {
    const header = view.getUint8(at)
    at += 1
    if (header & 0x80) throw new Error('compressed timestamp headers are not written')
    const localType = header & 0x0f

    if (header & 0x40) {
      const hasDev = (header & 0x20) !== 0
      at += 1 // reserved
      const architecture = view.getUint8(at)
      at += 1
      if (architecture !== 0) throw new Error('only little endian is written')
      const globalNum = view.getUint16(at, true)
      at += 2
      const fieldCount = view.getUint8(at)
      at += 1
      const fields = []
      for (let i = 0; i < fieldCount; i++) {
        fields.push({
          num: view.getUint8(at),
          size: view.getUint8(at + 1),
          type: view.getUint8(at + 2),
        })
        at += 3
      }
      const dev = []
      if (hasDev) {
        const devCount = view.getUint8(at)
        at += 1
        for (let i = 0; i < devCount; i++) {
          dev.push({
            num: view.getUint8(at),
            size: view.getUint8(at + 1),
            index: view.getUint8(at + 2),
          })
          at += 3
        }
      }
      definitions.set(localType, { globalNum, fields, dev })
      continue
    }

    const definition = definitions.get(localType)
    if (!definition) throw new Error(`data message for undefined local type ${localType}`)
    const message: DecodedMessage = { globalNum: definition.globalNum, fields: {}, dev: {} }
    for (const field of definition.fields) {
      // A field whose declared size does not match its base type would make
      // every field after it in the message garbage, so it is caught here.
      const expected = SIZE_OF[field.type]
      if (field.type !== 0x07 && field.size !== expected) {
        throw new Error(`field ${field.num} declares ${field.size} bytes for type ${field.type}`)
      }
      message.fields[field.num] = readField(at, field.size, field.type)
      at += field.size
    }
    for (const field of definition.dev) {
      // The declared base type comes from the field_description message.
      const description = messages.find(
        (m) => m.globalNum === 206 && m.fields[1] === field.num && m.fields[0] === field.index,
      )
      if (!description) throw new Error(`developer field ${field.num} was never described`)
      message.dev[field.num] = readField(at, field.size, Number(description.fields[2]))
      at += field.size
    }
    messages.push(message)
  }

  return { protocolVersion, dataSize, messages, crcValid, headerCrcValid }
}

const MESG = { fileId: 0, sport: 12, session: 18, lap: 19, record: 20, event: 21, activity: 34 }

// --- fixtures ---------------------------------------------------------------

const sample = (t: number, over: Partial<Sample> = {}): Sample => ({
  t,
  stepIndex: 0,
  phase: 'work',
  power: 200,
  heartRate: 140,
  cadence: 90,
  speedMs: 8,
  distanceM: t * 8,
  ...over,
})

function bikeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session_fit',
    protocolId: 'p',
    protocolName: 'Step test',
    sport: 'bike',
    athlete: { ...DEFAULT_ATHLETE, massKg: 75 },
    startedAt: Date.UTC(2026, 7, 13, 6, 43, 21),
    endedAt: Date.UTC(2026, 7, 13, 6, 44, 0),
    samples: [
      sample(0),
      sample(1),
      sample(2, { stepIndex: 1, power: 240 }),
      sample(3, { stepIndex: 1, power: 250 }),
    ],
    lactate: [{ stepIndex: 0, mmol: 2.4, rpe: 13, at: 0 }],
    ...over,
  }
}

const findAll = (file: DecodedFile, globalNum: number) =>
  file.messages.filter((m) => m.globalNum === globalNum)

// --- tests ------------------------------------------------------------------

describe('the FIT file envelope', () => {
  it('writes a readable header, a matching data size and a valid CRC', () => {
    const bytes = sessionToFit(bikeSession())
    const file = decodeFit(bytes)
    expect(file.protocolVersion).toBe(0x20)
    expect(file.headerCrcValid).toBe(true)
    expect(file.crcValid).toBe(true)
    // Header plus declared body plus the trailing CRC accounts for every byte.
    expect(bytes.length).toBe(14 + file.dataSize + 2)
  })

  /**
   * The CRC is the one part of the format with a published test value, so it is
   * checked against arithmetic rather than against this encoder's own output.
   */
  it('computes the FIT CRC variant', () => {
    expect(fitCrc(new Uint8Array([]))).toBe(0)
    // A CRC fed its own bytes back must return to zero, which is the property
    // the format relies on.
    const payload = new Uint8Array([0x0e, 0x20, 0x5c, 0x08, 0x10, 0x00, 0x00, 0x00])
    const crc = fitCrc(payload)
    const withCrc = new Uint8Array([...payload, crc & 0xff, (crc >> 8) & 0xff])
    expect(fitCrc(withCrc)).toBe(0)
  })

  it('identifies itself as an activity file made by this app', () => {
    const file = decodeFit(sessionToFit(bikeSession(), { appName: 'testday' }))
    const fileId = findAll(file, MESG.fileId)[0]
    expect(fileId.fields[0]).toBe(4) // activity
    expect(fileId.fields[8]).toBe('testday')
  })
})

describe('what the records carry', () => {
  it('writes one record per sample with the values scaled back correctly', () => {
    const file = decodeFit(sessionToFit(bikeSession()))
    const records = findAll(file, MESG.record)
    expect(records).toHaveLength(4)

    expect(records[0].fields[3]).toBe(140) // heart rate, bpm
    expect(records[0].fields[4]).toBe(90) // cadence
    expect(records[0].fields[7]).toBe(200) // power
    expect(Number(records[0].fields[6]) / 1000).toBeCloseTo(8, 3) // speed, m/s
    expect(Number(records[2].fields[5]) / 100).toBeCloseTo(16, 2) // distance, m
  })

  it('writes the gradient as a real field rather than as integrated altitude', () => {
    const session = bikeSession({
      sport: 'run',
      samples: [sample(0, { inclinePct: 2.5 }), sample(1, { inclinePct: -1.5 })],
    })
    const records = findAll(decodeFit(sessionToFit(session)), MESG.record)
    expect(Number(records[0].fields[9]) / 100).toBeCloseTo(2.5, 3)
    // Negative gradients need the signed type, which is what caught this.
    expect(Number(records[1].fields[9]) / 100).toBeCloseTo(-1.5, 3)
  })

  /**
   * FIT reads a scaled field back as `stored / scale - offset`, so the offset
   * has to go on before the scale. The other way round an altitude of 0 m is
   * stored as 500 and reads back as -400 m: wrong, but plausible enough to
   * survive into an analysis unnoticed. Caught by an independent decoder, not
   * by the reader in this file, which is why the assertion is on the metres.
   */
  it('applies a field offset before its scale', () => {
    const session = bikeSession({
      sport: 'run',
      samples: [
        sample(0, { inclinePct: 1.5, distanceM: 0 }),
        sample(1, { inclinePct: 1.5, distanceM: 1000 }),
      ],
    })
    const records = findAll(decodeFit(sessionToFit(session)), MESG.record)
    const metres = (raw: number) => raw / 5 - 500
    expect(metres(Number(records[0].fields[2]))).toBeCloseTo(0, 3)
    // 1000 m at 1.5% is 15 vertical metres.
    expect(metres(Number(records[1].fields[2]))).toBeCloseTo(15, 3)
  })

  it('carries lactate, RPE, the commanded target and the VO₂ estimate as developer fields', () => {
    const session = bikeSession({
      samples: [
        sample(0, { targetPower: 210, vo2Est: 35.8, vo2Method: 'acsmBike', coreTempC: 37.4 }),
        sample(1, { targetPower: 210, vo2Est: 36.1, vo2Method: 'acsmBike', coreTempC: 37.5 }),
      ],
    })
    const file = decodeFit(sessionToFit(session))

    const record = findAll(file, MESG.record)[0]
    expect(record.dev[0]).toBe(210) // target_power
    expect(Number(record.dev[3])).toBeCloseTo(35.8, 4) // vo2_estimate
    expect(record.dev[4]).toBe('acsmBike') // the equation, beside the number
    expect(Number(record.dev[5])).toBeCloseTo(37.4, 4) // core temperature

    const lap = findAll(file, MESG.lap)[0]
    expect(Number(lap.dev[12])).toBeCloseTo(2.4, 4) // blood lactate
    expect(lap.dev[13]).toBe(13) // Borg RPE
  })

  /** A channel with nothing in it should not appear in the file at all. */
  it('declares only the developer fields the session actually used', () => {
    const file = decodeFit(sessionToFit(bikeSession({ lactate: [] })))
    const descriptions = findAll(file, 206).map((m) => m.fields[3])
    expect(descriptions).not.toContain('core_temperature')
    expect(descriptions).not.toContain('blood_lactate')
  })

  it('records whether the gradient was measured or assumed', () => {
    const measured = decodeFit(
      sessionToFit(bikeSession({ samples: [sample(0, { inclinePct: 2 })] })),
    )
    expect(findAll(measured, MESG.record)[0].dev[10]).toBe(0)

    const assumed = decodeFit(
      sessionToFit(
        bikeSession({ samples: [sample(0, { inclinePct: 2, inclineFromTarget: true })] }),
      ),
    )
    expect(findAll(assumed, MESG.record)[0].dev[10]).toBe(1)
  })
})

describe('the developer data declaration', () => {
  /**
   * In `developer_data_id`, manufacturer_id is field 2 and developer_data_index
   * is field 3. Writing them one apart registers the index under the
   * manufacturer's value, every field_description then refers to an index that
   * was never declared, and a strict decoder rejects the entire file. The
   * round-trip reader in this file happily accepted it; a real one did not.
   */
  it('declares the developer index under the field number the profile uses', () => {
    const file = decodeFit(sessionToFit(bikeSession()))
    const declaration = file.messages.find((m) => m.globalNum === 207)
    expect(declaration?.fields[2]).toBe(255) // manufacturer_id: development
    expect(declaration?.fields[3]).toBe(0) // developer_data_index

    // And every described field points at that same index.
    for (const description of file.messages.filter((m) => m.globalNum === 206)) {
      expect(description.fields[0]).toBe(0)
    }
  })
})

describe('laps', () => {
  /** The directive was that a lap is cut where the next step starts. */
  it('cuts a lap at every step change', () => {
    const laps = findAll(decodeFit(sessionToFit(bikeSession())), MESG.lap)
    expect(laps).toHaveLength(2)
    expect(laps[0].fields[254]).toBe(0)
    expect(laps[1].fields[254]).toBe(1)
    expect(laps[0].fields[19]).toBe(200) // avg power of the first step
    expect(laps[1].fields[19]).toBe(245) // and of the second
  })

  /**
   * A step the operator jumped back to is a second visit, not a continuation.
   * Grouping by step index alone would silently merge the two.
   */
  it('makes a returned-to step its own lap', () => {
    const laps = fitLaps([
      sample(0, { stepIndex: 0 }),
      sample(1, { stepIndex: 1 }),
      sample(2, { stepIndex: 0 }),
    ])
    expect(laps.map((l) => l.stepIndex)).toEqual([0, 1, 0])
  })

  it('carries the step target as text on the lap', () => {
    const session = bikeSession()
    const protocol = makeProtocol('Step test', 'bike', [
      { id: 's1', durationS: 2, target: { mode: 'watts', watts: 200 } },
      { id: 's2', durationS: 2, target: { mode: 'watts', watts: 240 } },
    ])
    const laps = lapsFromSamples(session.samples, protocol, session.athlete)
    const file = decodeFit(sessionToFit(session, { laps, protocol }))
    expect(findAll(file, MESG.lap)[0].dev[14]).toBe('200 W')
  })
})

describe('the session summary', () => {
  it('declares an elapsed time that matches the number of recorded seconds', () => {
    // Four samples at t = 0..3 is four recorded seconds, not three. The TCX
    // writer this replaces declared 899 s for 900 of them.
    const file = decodeFit(sessionToFit(bikeSession()))
    const session = findAll(file, MESG.session)[0]
    expect(Number(session.fields[7]) / 1000).toBeCloseTo(4, 3)
    expect(Number(session.fields[26])).toBe(2) // num_laps
  })

  it('labels the sport and sub-sport', () => {
    const bike = findAll(decodeFit(sessionToFit(bikeSession())), MESG.session)[0]
    expect(bike.fields[5]).toBe(2) // cycling
    expect(bike.fields[6]).toBe(6) // indoor cycling

    const run = findAll(decodeFit(sessionToFit(bikeSession({ sport: 'run' }))), MESG.session)[0]
    expect(run.fields[5]).toBe(1) // running
    expect(run.fields[6]).toBe(1) // treadmill
  })

  it('writes calories, which TCX required and the old writer omitted', () => {
    const session = bikeSession({
      samples: Array.from({ length: 60 }, (_, t) => sample(t, { vo2Est: 40 })),
    })
    const summary = findAll(decodeFit(sessionToFit(session)), MESG.session)[0]
    // 40 mL/kg/min × 75 kg = 3 L/min = 15 kcal/min over one minute.
    expect(Number(summary.fields[11])).toBeCloseTo(15, 0)
  })

  it('brackets the records with a timer start and a timer stop', () => {
    const events = findAll(decodeFit(sessionToFit(bikeSession())), MESG.event)
    expect(events[0].fields[1]).toBe(0) // start
    expect(events[events.length - 1].fields[1]).toBe(4) // stop_all
  })

  it('writes an activity message so the file is a complete activity', () => {
    expect(findAll(decodeFit(sessionToFit(bikeSession())), MESG.activity)).toHaveLength(1)
  })
})

describe('degenerate sessions', () => {
  it('writes a valid file for a session with no samples', () => {
    const file = decodeFit(sessionToFit(bikeSession({ samples: [], lactate: [] })))
    expect(file.crcValid).toBe(true)
    expect(findAll(file, MESG.record)).toHaveLength(0)
    expect(Number(findAll(file, MESG.session)[0].fields[7])).toBe(0)
  })

  /**
   * A wrapped number reads as a real measurement, which is worse than a gap, so
   * anything that will not fit its field becomes the invalid value instead.
   */
  it('blanks a value too large for its field rather than wrapping it', () => {
    const session = bikeSession({ samples: [sample(0, { power: 70000 })] })
    const record = findAll(decodeFit(sessionToFit(session)), MESG.record)[0]
    expect(record.fields[7]).toBe(0xffff) // invalid, not 4464
  })

  it('leaves a missing metric blank rather than writing a zero', () => {
    const session = bikeSession({
      samples: [{ t: 0, stepIndex: 0, phase: 'work', power: 200 }],
    })
    const record = findAll(decodeFit(sessionToFit(session)), MESG.record)[0]
    expect(record.fields[3]).toBe(0xff) // heart rate: invalid, not 0 bpm
    expect(record.fields[4]).toBe(0xff)
  })
})

describe('kcalOver', () => {
  it('uses the recorded oxygen estimate when there is one', () => {
    const samples = Array.from({ length: 60 }, (_, t) => sample(t, { vo2Est: 40 }))
    expect(kcalOver(samples, 75)).toBeCloseTo(15, 1)
  })

  it('falls back to mechanical work when there is no estimate', () => {
    const samples = Array.from({ length: 60 }, (_, t) => sample(t, { power: 200 }))
    // 200 W for 60 s is 12 kJ of work, about 13 kcal at 22% gross efficiency.
    expect(kcalOver(samples, 75)).toBeCloseTo(13, 0)
  })
})
