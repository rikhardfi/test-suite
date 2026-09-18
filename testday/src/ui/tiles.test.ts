import { describe, expect, it } from 'vitest'
import { TILES, defaultFrontFor, tileByKey, tilesForSport, type TileContext } from './tiles'
import { DEFAULT_ATHLETE, makeProtocol } from '../model/protocol'
import type { Sample } from '../model/session'

const protocol = (sport: 'bike' | 'run' = 'bike') =>
  makeProtocol('Test', sport, [{ id: 's1', durationS: 300, target: { mode: 'watts', watts: 200 } }])

const context = (over: Partial<TileContext> = {}): TileContext => ({
  metrics: {},
  snapshot: {
    state: 'running',
    elapsedS: 65,
    stepIndex: 0,
    phase: 'work',
    phaseRemainingS: 235,
    stepProgress: 0.2,
    intensityPct: 100,
    targetPower: 200,
    targetKph: null,
    commandedPower: null,
    powerMatchFactor: null,
    powerMatchState: null,
    step: null,
    totalS: 300,
    controlError: null,
  controlAck: null,
  controlBehindS: 0,
  },
  athlete: { ...DEFAULT_ATHLETE, massKg: 75, ftpWatts: 300, maxHr: 190, restingHr: 50 },
  protocol: protocol(),
  samples: [],
  cp: null,
  rr: [],
  ...over,
})

const sample = (over: Partial<Sample> = {}): Sample => ({
  t: 0,
  stepIndex: 0,
  phase: 'work',
  ...over,
})

const compute = (key: string, c: TileContext) => tileByKey(key)!.compute(c)

describe('the tile registry', () => {
  it('gives every tile a unique key, a label and an explanation', () => {
    const keys = TILES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const tile of TILES) {
      expect(tile.label.length).toBeGreaterThan(0)
      expect(tile.about.length).toBeGreaterThan(20)
    }
  })

  it('offers only tiles that apply to the sport', () => {
    expect(tilesForSport('run').map((t) => t.key)).toContain('pace')
    expect(tilesForSport('run').map((t) => t.key)).not.toContain('wattsPerKg')
    expect(tilesForSport('bike').map((t) => t.key)).not.toContain('pace')
  })

  it('has a default front face made only of tiles that exist for that sport', () => {
    for (const sport of ['bike', 'run'] as const) {
      const available = new Set(tilesForSport(sport).map((t) => t.key))
      for (const key of defaultFrontFor(sport)) expect(available.has(key)).toBe(true)
    }
  })

  /**
   * A grid full of dashes trains people to stop reading the grid, so a tile
   * with nothing to say is dropped instead.
   */
  it('computes nothing when the metric behind it is absent', () => {
    const empty = context()
    for (const tile of TILES) {
      const value = tile.compute(empty)
      // The clock and the commanded target come from the protocol rather than
      // from a sensor, so they always have something to say. Nothing that
      // depends on a measurement should.
      if (
        ['timer', 'lapLeft', 'intensity', 'stepProgress', 'targetPower'].includes(tile.key)
      ) {
        expect(value).not.toBeNull()
      } else {
        expect(value, `${tile.key} should be hidden with no data`).toBeNull()
      }
    }
  })
})

describe('what the tiles say about their own numbers', () => {
  it('marks a VO₂ estimate outside the equation’s range as suspect', () => {
    const inRange = compute(
      'vo2',
      context({ samples: [sample({ power: 150, vo2Est: 28.6, vo2Method: 'acsmBike' })] }),
    )
    expect(inRange?.suspect).toBeFalsy()
    expect(inRange?.note).toContain('ACSM')

    // 400 W is well past the 50 to 200 W the regression was fitted over.
    const extrapolated = compute(
      'vo2',
      context({ samples: [sample({ power: 400, vo2Est: 64.6, vo2Method: 'acsmBike' })] }),
    )
    expect(extrapolated?.suspect).toBe(true)
    expect(extrapolated?.note).toContain('outside')
  })

  /** The equation always travels with the number it produced. */
  it('names the equation on every VO₂ estimate', () => {
    const value = compute(
      'vo2',
      context({ samples: [sample({ power: 150, vo2Est: 28.6, vo2Method: 'acsmBike' })] }),
    )
    expect(value?.note).toContain('ACSM leg ergometry')
  })

  it('says whether a gradient was measured or assumed', () => {
    const run = context({ protocol: protocol('run') })
    const measured = compute('incline', { ...run, metrics: { inclinePct: 2 } })
    expect(measured?.note).toBe('measured')

    const assumed = compute('incline', {
      ...run,
      samples: [sample({ inclinePct: 2, inclineFromTarget: true })],
    })
    expect(assumed?.note).toBe('commanded')
  })

  it('says when a distance was integrated rather than read from the machine', () => {
    const integrated = compute(
      'distance',
      context({ samples: [sample({ distanceM: 1500, distanceIntegrated: true })] }),
    )
    expect(integrated?.value).toBe('1.50')
    expect(integrated?.note).toBe('from speed')

    const odometer = compute('distance', context({ samples: [sample({ distanceM: 1500 })] }))
    expect(odometer?.note).toBeUndefined()
  })

  /**
   * Variability at 170 bpm is mechanical and respiratory artefact, not
   * autonomic tone. The number is still shown, because the operator decides
   * what to trust, but it is not shown as if it meant the same thing.
   */
  it('marks HRV taken at a hard intensity as not meaningful', () => {
    const rr = Array.from({ length: 40 }, () => 340) // about 176 bpm
    const hard = compute('hrv', context({ rr }))
    expect(hard?.suspect).toBe(true)
    expect(hard?.note).toContain('not meaningful')

    const resting = compute('hrv', context({ rr: Array.from({ length: 40 }, () => 1000) }))
    expect(resting?.suspect).toBeFalsy()
  })

  it('hides percentage of maximum heart rate when no maximum is recorded', () => {
    const withMax = compute('pctMaxHr', context({ metrics: { heartRate: 152 } }))
    expect(withMax?.value).toBe('80')

    const noMax = compute(
      'pctMaxHr',
      context({ metrics: { heartRate: 152 }, athlete: { ...DEFAULT_ATHLETE, maxHr: undefined } }),
    )
    // Guessing 220 minus age would produce a number, and the number would be
    // about the population rather than about this athlete.
    expect(noMax).toBeNull()
  })

  it('hides W′ balance when there is no valid critical power fit', () => {
    expect(compute('wPrime', context({ samples: [sample({ power: 300 })] }))).toBeNull()

    const withFit = compute(
      'wPrime',
      context({
        samples: [sample({ power: 300 })],
        cp: { cpWatts: 250, wPrimeJoules: 20000, r2: 0.99, usedDurations: [120, 300, 600] },
      }),
    )
    expect(withFit?.note).toContain('CP 250 W')
  })

  it('shows the estimate against a measured VO₂max when there is one', () => {
    const c = context({
      samples: [sample({ power: 200, vo2Est: 40, vo2Method: 'acsmBike' })],
      athlete: { ...DEFAULT_ATHLETE, vo2maxMlKgMin: 60 },
    })
    expect(compute('pctVo2max', c)?.value).toBe('67')
    expect(compute('pctVo2max', context())).toBeNull()
  })
})
