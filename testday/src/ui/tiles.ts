import { formatClock, formatCountdown, hrv, paceFromSpeed, normalizedPower } from '../model/metrics'
import { decoupling, wPrimeBalance, type CriticalPowerResult } from '../model/analysis'
import { VO2_METHODS, computeKcal, pctOfVo2max, type Vo2Method } from '../model/vo2'
import { CORE_QUALITY } from '../ble/parse'
import type { Athlete, Protocol } from '../model/protocol'
import type { RunnerSnapshot, Sample } from '../model/session'
import type { MetricUpdate } from '../ble/types'

/**
 * Every number the dashboard can show, declared once.
 *
 * The dashboard used to hard-code seven tiles, which meant adding a metric
 * meant editing a component and there was nowhere for the ones that are only
 * occasionally interesting. A registry instead: the front face shows whichever
 * of these the operator picked, the back face shows all of them, and a new
 * sensor becomes visible by adding an entry rather than by touching layout.
 *
 * A tile that cannot be computed returns null and is hidden rather than showing
 * a dash, because a dashboard full of dashes trains people to stop reading it.
 */

export interface TileContext {
  metrics: MetricUpdate
  snapshot: RunnerSnapshot
  athlete: Athlete
  protocol: Protocol
  samples: readonly Sample[]
  /** Fitted from previous sessions, when there is a usable fit. */
  cp: CriticalPowerResult | null
  rr: readonly number[]
}

export type TileTone = 'power' | 'heart' | 'target' | 'lactate' | 'core' | 'vo2'

export interface TileValue {
  value: string
  unit?: string
  /** Second line: a qualifier, a method name, or the reason to distrust it. */
  note?: string
  /** Set when the number is outside the range its equation was fitted over. */
  suspect?: boolean
}

export interface TileDef {
  key: string
  label: string
  tone?: TileTone
  /** Wide tiles take two columns. Reserved for the ones read from across a room. */
  wide?: boolean
  /** Which sports it applies to. Absent means both. */
  sport?: 'bike' | 'run'
  /** Short explanation, shown in the tile picker. */
  about: string
  compute: (context: TileContext) => TileValue | null
}

const fmt = (value: number | undefined | null, decimals = 0): string | null =>
  value == null || !Number.isFinite(value) ? null : value.toFixed(decimals)

const workSamples = (context: TileContext): Sample[] =>
  context.samples.filter((s) => s.stepIndex === context.snapshot.stepIndex && s.phase === 'work')

export const TILES: readonly TileDef[] = [
  // --- the essentials -------------------------------------------------------
  {
    key: 'timer',
    label: 'Timer',
    tone: 'power',
    wide: true,
    about: 'Elapsed session time. Stops while the test is paused.',
    compute: (c) => ({ value: formatClock(c.snapshot.elapsedS) }),
  },
  {
    key: 'lapLeft',
    label: 'Lap time left',
    tone: 'heart',
    wide: true,
    about: 'Time left in the current work phase, or in the sampling break.',
    compute: (c) => ({
      value: formatCountdown(c.snapshot.phaseRemainingS),
      note: c.snapshot.phase === 'break' ? 'sample break' : undefined,
    }),
  },
  {
    key: 'heartRate',
    label: 'Heart rate',
    tone: 'heart',
    wide: true,
    about: 'Live heart rate from the most authoritative connected source.',
    compute: (c) => {
      const value = fmt(c.metrics.heartRate)
      return value ? { value, unit: 'bpm' } : null
    },
  },
  {
    key: 'power',
    label: 'Power',
    tone: 'power',
    sport: 'bike',
    about: 'Measured mechanical power.',
    compute: (c) => {
      const value = fmt(c.metrics.power)
      return value ? { value, unit: 'W' } : null
    },
  },
  {
    key: 'speed',
    label: 'Speed',
    tone: 'power',
    sport: 'run',
    about: 'Measured belt or ground speed.',
    compute: (c) => {
      const value = fmt(c.metrics.speedMs == null ? undefined : c.metrics.speedMs * 3.6, 1)
      return value ? { value, unit: 'km/h' } : null
    },
  },
  {
    key: 'cadence',
    label: 'Cadence',
    about: 'Pedal revolutions or steps per minute, whichever the sport calls for.',
    compute: (c) => {
      const value = fmt(c.metrics.cadence)
      return value ? { value, unit: c.protocol.sport === 'run' ? 'spm' : 'rpm' } : null
    },
  },
  {
    key: 'targetPower',
    label: 'Target power',
    tone: 'target',
    sport: 'bike',
    about: 'What the trainer is being commanded to hold right now.',
    compute: (c) => {
      const value = fmt(c.snapshot.targetPower)
      return value ? { value, unit: 'W' } : null
    },
  },
  {
    key: 'targetSpeed',
    label: 'Target speed',
    tone: 'target',
    sport: 'run',
    about: 'What the treadmill is being commanded to hold right now.',
    compute: (c) => {
      const value = fmt(c.snapshot.targetKph, 1)
      return value ? { value, unit: 'km/h' } : null
    },
  },

  // --- run specific ---------------------------------------------------------
  {
    key: 'pace',
    label: 'Pace',
    sport: 'run',
    about: 'Minutes per kilometre, from measured speed.',
    compute: (c) =>
      c.metrics.speedMs ? { value: paceFromSpeed(c.metrics.speedMs), unit: '/km' } : null,
  },
  {
    key: 'incline',
    label: 'Gradient',
    sport: 'run',
    about:
      'Treadmill gradient. Says whether it was read from the machine or assumed from what the machine was told.',
    compute: (c) => {
      const last = c.samples[c.samples.length - 1]
      const measured = c.metrics.inclinePct
      const value = fmt(measured ?? last?.inclinePct, 1)
      if (!value) return null
      return {
        value,
        unit: '%',
        note: measured != null ? 'measured' : 'commanded',
      }
    },
  },
  {
    key: 'vertical',
    label: 'Vertical',
    sport: 'run',
    about: 'Metres climbed, accumulated from gradient and distance.',
    compute: (c) => {
      let climb = 0
      let previous = 0
      for (const sample of c.samples) {
        const distance = sample.distanceM ?? previous
        if (sample.inclinePct != null && distance > previous) {
          climb += (distance - previous) * (sample.inclinePct / 100)
        }
        previous = distance
      }
      return climb > 0 ? { value: climb.toFixed(0), unit: 'm' } : null
    },
  },
  {
    key: 'distance',
    label: 'Distance',
    about: 'Distance covered, preferring the machine odometer.',
    compute: (c) => {
      const last = c.samples[c.samples.length - 1]
      if (last?.distanceM == null) return null
      return {
        value: (last.distanceM / 1000).toFixed(2),
        unit: 'km',
        note: last.distanceIntegrated ? 'from speed' : undefined,
      }
    },
  },

  // --- oxygen cost ----------------------------------------------------------
  {
    key: 'vo2',
    label: 'VO₂ (est.)',
    tone: 'vo2',
    about:
      'Oxygen cost estimated from a population regression. Not a measurement, and it says which equation produced it.',
    compute: (c) => {
      const last = [...c.samples].reverse().find((s) => s.vo2Est != null)
      if (!last?.vo2Est || !last.vo2Method) return null
      const info = VO2_METHODS[last.vo2Method as Vo2Method]
      const driver = last.vo2Method === 'acsmBike' ? last.power : (last.speedMs ?? 0) * 3.6
      const inRange =
        driver != null && driver >= info.validFrom && driver <= info.validTo
      return {
        value: last.vo2Est.toFixed(1),
        unit: 'mL/kg/min',
        // The method travels with the number, always. An estimate that does not
        // say it is one becomes a measurement the moment it is written down.
        note: inRange
          ? info.label
          : `${info.label}, outside ${info.validFrom}-${info.validTo} ${info.validUnit}`,
        suspect: !inRange,
      }
    },
  },
  {
    key: 'pctVo2max',
    label: '% of VO₂max',
    tone: 'vo2',
    about:
      'The estimate as a share of a measured VO₂max. Anchored to this athlete rather than to a population, so it is the more useful of the two.',
    compute: (c) => {
      const max = c.athlete.vo2maxMlKgMin
      const last = [...c.samples].reverse().find((s) => s.vo2Est != null)
      if (!max || !last?.vo2Est) return null
      const pct = pctOfVo2max(last.vo2Est, max)
      return pct == null ? null : { value: pct.toFixed(0), unit: '%', note: 'of measured max' }
    },
  },
  {
    key: 'kcal',
    label: 'Energy',
    about: 'Cumulative energy cost, from the oxygen estimate where there is one.',
    compute: (c) => {
      let kcal = 0
      for (const s of c.samples) {
        if (s.vo2Est != null) kcal += computeKcal(s.vo2Est, c.athlete.massKg, 1 / 60)
        else if (s.power != null) kcal += s.power / 1000 / 4.184 / 0.22
      }
      return kcal > 0 ? { value: kcal.toFixed(0), unit: 'kcal' } : null
    },
  },
  {
    key: 'work',
    label: 'Work',
    sport: 'bike',
    about: 'Cumulative mechanical work, which is the most direct measure of what was done.',
    compute: (c) => {
      let kj = 0
      for (const s of c.samples) if (s.power != null) kj += s.power / 1000
      return kj > 0 ? { value: kj.toFixed(0), unit: 'kJ' } : null
    },
  },

  // --- relative to the athlete ---------------------------------------------
  {
    key: 'wattsPerKg',
    label: 'W/kg',
    tone: 'power',
    sport: 'bike',
    about: 'Power per kilogram of body mass.',
    compute: (c) => {
      if (c.metrics.power == null || !(c.athlete.massKg > 0)) return null
      return { value: (c.metrics.power / c.athlete.massKg).toFixed(2), unit: 'W/kg' }
    },
  },
  {
    key: 'pctFtp',
    label: '% of threshold',
    tone: 'power',
    sport: 'bike',
    about: 'Current power as a share of the athlete’s threshold power.',
    compute: (c) => {
      if (c.metrics.power == null || !(c.athlete.ftpWatts > 0)) return null
      return { value: ((c.metrics.power / c.athlete.ftpWatts) * 100).toFixed(0), unit: '%' }
    },
  },
  {
    key: 'pctMaxHr',
    label: '% of max HR',
    tone: 'heart',
    about:
      'Heart rate as a share of the athlete’s maximum. Hidden when no maximum has been recorded, rather than guessed from age.',
    compute: (c) => {
      const max = c.athlete.maxHr
      if (!max || c.metrics.heartRate == null) return null
      return { value: ((c.metrics.heartRate / max) * 100).toFixed(0), unit: '%' }
    },
  },
  {
    key: 'hrReserve',
    label: '% of HR reserve',
    tone: 'heart',
    about: 'Where the heart rate sits between resting and maximum.',
    compute: (c) => {
      const { maxHr, restingHr } = c.athlete
      const hr = c.metrics.heartRate
      if (!maxHr || !restingHr || hr == null || maxHr <= restingHr) return null
      return { value: (((hr - restingHr) / (maxHr - restingHr)) * 100).toFixed(0), unit: '%' }
    },
  },

  // --- modelled -------------------------------------------------------------
  {
    key: 'wPrime',
    label: 'W′ balance',
    tone: 'power',
    sport: 'bike',
    about:
      'How much of the anaerobic work capacity is left, by the differential model. Hidden entirely when there is no valid critical power fit, because the number is meaningless without one.',
    compute: (c) => {
      if (!c.cp) return null
      const balance = wPrimeBalance(
        c.samples.map((s) => s.power ?? 0),
        c.cp.cpWatts,
        c.cp.wPrimeJoules,
      )
      const now = balance[balance.length - 1]
      if (now == null) return null
      return {
        value: (now / 1000).toFixed(1),
        unit: 'kJ',
        note: `${((now / c.cp.wPrimeJoules) * 100).toFixed(0)}% of W′, CP ${Math.round(c.cp.cpWatts)} W`,
      }
    },
  },
  {
    key: 'normalizedPower',
    label: 'Normalised power',
    tone: 'power',
    sport: 'bike',
    about: 'Fourth-power weighted average, over the session so far.',
    compute: (c) => {
      const np = normalizedPower(c.samples.map((s) => s.power ?? 0))
      return np == null ? null : { value: np.toFixed(0), unit: 'W' }
    },
  },
  {
    key: 'decoupling',
    label: 'Decoupling',
    tone: 'heart',
    about:
      'Drift in output per heartbeat across the current step. Needs a steady block of at least two minutes, and stays hidden otherwise rather than reporting noise.',
    compute: (c) => {
      const step = workSamples(c)
      const output =
        c.protocol.sport === 'run'
          ? step.map((s) => (s.speedMs ?? 0) * 3.6)
          : step.map((s) => s.power ?? 0)
      const result = decoupling(
        output,
        step.map((s) => s.heartRate ?? 0),
      )
      if (!result) return null
      return {
        value: `${result.pctDrift > 0 ? '+' : ''}${result.pctDrift.toFixed(1)}`,
        unit: '%',
        note: 'this step',
      }
    },
  },

  // --- the breath: TSI flow meter on the expiratory limb ----------------------
  {
    key: 'expFlow',
    label: 'Exhaled flow',
    tone: 'vo2',
    about:
      'Mean exhaled flow through the TSI meter over the last quarter second, Std L/min: dry gas at 21.11 °C and 101.3 kPa, not BTPS, so it reads below minute ventilation.',
    compute: (c) =>
      c.metrics.expFlowLMin == null
        ? null
        : { value: c.metrics.expFlowLMin.toFixed(1), unit: 'L/min', note: 'Std, dry gas' },
  },
  {
    key: 'expGas',
    label: 'Exhaled gas',
    tone: 'vo2',
    about:
      'Temperature and relative humidity of the gas in the flow meter. The humidity sensor responds over seconds, so this follows the trend across breaths, never a single breath. Blank at 100 % RH, which is condensation rather than a reading.',
    compute: (c) => {
      if (c.metrics.expTempC == null) return null
      return {
        value: c.metrics.expTempC.toFixed(1),
        unit: '°C',
        note:
          c.metrics.expHumidityPct != null
            ? `${c.metrics.expHumidityPct.toFixed(0)} %RH`
            : 'humidity saturated',
        suspect: c.metrics.expHumidityPct == null,
      }
    },
  },
  {
    key: 'expVolume',
    label: 'Exhaled volume',
    tone: 'vo2',
    about:
      "The flow meter's running volume since it was last reset (Sensors → TSI flow meter → Reset volume), Std L.",
    compute: (c) =>
      c.metrics.expTotalL == null ? null : { value: c.metrics.expTotalL.toFixed(1), unit: 'L', note: 'since reset' },
  },

  // --- the body -------------------------------------------------------------
  {
    key: 'coreTemp',
    label: 'Core temp',
    tone: 'core',
    about: 'CORE sensor estimate, with the quality the sensor put on its own reading.',
    compute: (c) => {
      if (c.metrics.coreTempC == null) return null
      const parts: string[] = []
      if (c.metrics.coreQuality != null) {
        parts.push(CORE_QUALITY[c.metrics.coreQuality] ?? `quality ${c.metrics.coreQuality}`)
      }
      if (c.metrics.skinTempC != null) parts.push(`skin ${c.metrics.skinTempC.toFixed(1)}°`)
      return {
        value: c.metrics.coreTempC.toFixed(2),
        unit: '°C',
        note: parts.join(' · ') || undefined,
      }
    },
  },
  {
    key: 'heatStrain',
    label: 'Heat strain',
    tone: 'core',
    about: 'CORE heat strain index, 0 to 25.4.',
    compute: (c) =>
      c.metrics.heatStrainIndex == null
        ? null
        : { value: c.metrics.heatStrainIndex.toFixed(1) },
  },
  {
    key: 'hrv',
    label: 'HRV (rMSSD)',
    tone: 'heart',
    about:
      'Beat-to-beat variability over the last two minutes. Only interpretable at rest or in recovery: during a hard stage this is mechanical and respiratory artefact, not autonomic tone.',
    compute: (c) => {
      const result = hrv(c.rr)
      if (!result) return null
      const hard = c.athlete.maxHr ? result.meanHr > c.athlete.maxHr * 0.75 : result.meanHr > 140
      return {
        value: result.rmssd.toFixed(0),
        unit: 'ms',
        note: hard ? 'not meaningful at this intensity' : `${result.beats} beats`,
        suspect: hard,
      }
    },
  },

  // --- the machine ----------------------------------------------------------
  {
    key: 'resistance',
    label: 'Resistance',
    sport: 'bike',
    about: 'Trainer resistance level, which is what the athlete works against off ERG.',
    compute: (c) => {
      const value = fmt(c.metrics.resistance)
      return value ? { value } : null
    },
  },
  {
    key: 'intensity',
    label: 'Intensity trim',
    tone: 'target',
    about: 'The global trim applied to every target. 100% is the protocol as written.',
    compute: (c) => ({ value: String(c.snapshot.intensityPct), unit: '%' }),
  },
  {
    key: 'stepProgress',
    label: 'Step progress',
    about: 'How far through the current step, including its sampling break.',
    compute: (c) => ({ value: (c.snapshot.stepProgress * 100).toFixed(0), unit: '%' }),
  },
  {
    key: 'lapAvgPower',
    label: 'Step avg power',
    tone: 'power',
    sport: 'bike',
    about: 'Average power over the work phase of the current step.',
    compute: (c) => {
      const values = workSamples(c)
        .map((s) => s.power)
        .filter((p): p is number => p != null)
      if (!values.length) return null
      return { value: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(0), unit: 'W' }
    },
  },
  {
    key: 'lapAvgHr',
    label: 'Step avg HR',
    tone: 'heart',
    about: 'Average heart rate over the work phase of the current step.',
    compute: (c) => {
      const values = workSamples(c)
        .map((s) => s.heartRate)
        .filter((p): p is number => p != null)
      if (!values.length) return null
      return { value: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(0), unit: 'bpm' }
    },
  },
]

/** The tiles that apply to a sport, in registry order. */
export const tilesForSport = (sport: 'bike' | 'run'): TileDef[] =>
  TILES.filter((tile) => !tile.sport || tile.sport === sport)

/** What the front face shows when the operator has not chosen. */
export const DEFAULT_FRONT_BIKE = [
  'timer',
  'lapLeft',
  'heartRate',
  'cadence',
  'power',
  'targetPower',
  'vo2',
  'coreTemp',
]

export const DEFAULT_FRONT_RUN = [
  'timer',
  'lapLeft',
  'heartRate',
  'cadence',
  'speed',
  'targetSpeed',
  'pace',
  'incline',
  'vo2',
  'coreTemp',
]

export const defaultFrontFor = (sport: 'bike' | 'run'): string[] =>
  sport === 'run' ? [...DEFAULT_FRONT_RUN] : [...DEFAULT_FRONT_BIKE]

export const tileByKey = (key: string): TileDef | undefined => TILES.find((t) => t.key === key)
