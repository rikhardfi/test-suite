import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  RESEARCH_EXPORT_VERSION,
  SAMPLE_COLUMNS,
  participantCode,
  pseudonymise,
  researchSidecar,
} from './research'
import { sampleRow, samplesToCsv } from './export'
import { APP_VERSION } from './version'
import { DEFAULT_ATHLETE, makeProtocol } from './protocol'
import type { SessionRecord } from './session'

const session = (): SessionRecord => ({
  id: 'session_research',
  protocolId: 'p',
  protocolName: 'Step test',
  sport: 'bike',
  athlete: { ...DEFAULT_ATHLETE, name: 'Some Athlete', massKg: 75 },
  startedAt: Date.UTC(2026, 7, 13, 6, 43, 21),
  samples: [
    { t: 0, stepIndex: 0, phase: 'work', power: 200, heartRate: 140, vo2Est: 35.8, vo2Method: 'acsmBike' },
    { t: 1, stepIndex: 0, phase: 'work', power: 205, heartRate: 142 },
  ],
  lactate: [{ stepIndex: 0, mmol: 2.4, at: 0 }],
  events: [
    { kind: 'start', at: Date.UTC(2026, 7, 13, 6, 43, 21) },
    { kind: 'intensity', at: Date.UTC(2026, 7, 13, 6, 45, 0), data: { pct: 97 } },
  ],
})

describe('the CSV column contract', () => {
  /**
   * The header and the rows are built from the same list, and this is what
   * catches a column added to one and not the other. A row that has drifted out
   * of alignment with its header is silent and ruins every downstream analysis.
   */
  it('writes exactly one cell per declared column', () => {
    expect(sampleRow(session().samples[0])).toHaveLength(SAMPLE_COLUMNS.length)
  })

  it('writes the declared names as the header, in order', () => {
    const header = samplesToCsv(session()).split('\n')[0]
    expect(header).toBe(SAMPLE_COLUMNS.map((c) => c.name).join(','))
  })

  /** Every column has to say what it is and what unit it is in. */
  it('documents every column', () => {
    for (const column of SAMPLE_COLUMNS) {
      expect(column.name).toMatch(/^[a-z0-9_]+$/)
      expect(column.description.length).toBeGreaterThan(0)
    }
  })

  /**
   * A blank cell means the sensor reported nothing. A zero is a measurement.
   * Conflating them is the mistake this export exists to avoid.
   */
  it('leaves an unreported metric blank rather than zero', () => {
    const row = sampleRow({ t: 0, stepIndex: 0, phase: 'work' })
    const heartRate = row[SAMPLE_COLUMNS.findIndex((c) => c.name === 'heart_rate_bpm')]
    expect(heartRate).toBe('')
  })
})

describe('participant codes', () => {
  it('is stable for the same name and salt', () => {
    expect(participantCode('Some Athlete', 'salt')).toBe(participantCode('Some Athlete', 'salt'))
  })

  it('ignores case and surrounding space, which are typing noise', () => {
    expect(participantCode('  some athlete ', 's')).toBe(participantCode('Some Athlete', 's'))
  })

  it('differs between athletes and between machines', () => {
    expect(participantCode('A', 'salt')).not.toBe(participantCode('B', 'salt'))
    // The salt is what stops a code being derivable by anyone holding the files.
    expect(participantCode('A', 'salt1')).not.toBe(participantCode('A', 'salt2'))
  })

  it('never contains the name it was made from', () => {
    const code = participantCode('Mäki-Heikkilä', 'salt')
    expect(code.toLowerCase()).not.toContain('ki')
    expect(code).toMatch(/^P-[0-9A-Z]{10}$/)
  })
})

describe('the research sidecar', () => {
  it('replaces the athlete name with a code everywhere it appears', () => {
    const anonymous = pseudonymise(session(), 'salt')
    expect(anonymous.athlete.name).toBe(participantCode('Some Athlete', 'salt'))

    const sidecar = researchSidecar(anonymous, { appVersion: APP_VERSION, salt: 'salt' })
    expect(sidecar).not.toContain('Some Athlete')
    expect(JSON.parse(sidecar).session.participant).toMatch(/^P-/)
  })

  it('keeps the inputs the derived numbers depend on', () => {
    // Mass and threshold power are arguments to the equations, so an export
    // without them cannot be recomputed. They identify nobody.
    const parsed = JSON.parse(researchSidecar(session(), { appVersion: APP_VERSION }))
    expect(parsed.athlete.massKg).toBe(75)
    expect(parsed.athlete.ftpWatts).toBe(DEFAULT_ATHLETE.ftpWatts)
  })

  it('documents every column the CSV writes', () => {
    const parsed = JSON.parse(researchSidecar(session(), { appVersion: APP_VERSION }))
    expect(parsed.columns.map((c: { name: string }) => c.name)).toEqual(
      SAMPLE_COLUMNS.map((c) => c.name),
    )
  })

  /** An estimate that does not say it is an estimate becomes a measurement. */
  it('names each VO₂ equation, its range and what kind of number it is', () => {
    const parsed = JSON.parse(researchSidecar(session(), { appVersion: APP_VERSION }))
    const methods = parsed.methods.vo2
    expect(methods.map((m: { id: string }) => m.id)).toContain('acsmBike')
    for (const method of methods) {
      expect(method.validatedRange).toMatch(/to/)
      expect(method.kind).toContain('not a measurement')
    }
  })

  it('records the protocol as written and as executed side by side', () => {
    const protocol = makeProtocol('Step test', 'bike', [
      { id: 's1', durationS: 60, target: { mode: 'watts', watts: 200 } },
    ])
    const parsed = JSON.parse(
      researchSidecar(session(), {
        appVersion: APP_VERSION,
        protocol,
        events: [
          { type: 'event', kind: 'start', at: 1 },
          { type: 'event', kind: 'intensity', at: 2, data: { pct: 97 } },
        ],
      }),
    )
    expect(parsed.protocolAsWritten.steps[0].durationS).toBe(60)
    // The trim is the whole reason both are recorded: the athlete did not run
    // the protocol that was written.
    expect(parsed.protocolAsExecuted.map((e: { action: string }) => e.action)).toEqual([
      'start',
      'intensity',
    ])
    expect(parsed.protocolAsExecuted[1].detail.pct).toBe(97)
  })

  it('stamps the version that produced it', () => {
    const parsed = JSON.parse(researchSidecar(session(), { appVersion: APP_VERSION }))
    expect(parsed.generatedBy).toBe(`testday ${APP_VERSION}`)
    expect(parsed.formatVersion).toBe(RESEARCH_EXPORT_VERSION)
  })
})

describe('the version stamp', () => {
  /** A stamp that has drifted from the real version is worse than none. */
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(APP_VERSION).toBe(pkg.version)
  })
})
