import { lapsFromSamples, type Sample, type SessionRecord } from './session'
import { makeProtocol, type Protocol } from './protocol'
import { APP_NAME, APP_VERSION } from './version'

/**
 * A deterministic session, and exactly what an independent decoder should make
 * of the FIT file written from it.
 *
 * Both halves live here, next to the encoder, so the expectations are written
 * in the same terms as the thing they describe rather than duplicated into a
 * Python script that would drift away from it.
 *
 * The numbers are chosen to make every check exact rather than approximate: a
 * constant 10 m/s means distance is ten times the timestamp, a constant 1.5%
 * gradient means the altitude trace is a straight line, and constant power and
 * heart rate per step mean the lap averages are the step values themselves. A
 * fixture whose expected values need arithmetic to state is a fixture nobody
 * checks by hand when it fails.
 */

const START = Date.UTC(2026, 7, 13, 6, 43, 21)
const STEPS = 3
const SAMPLES_PER_STEP = 60
const SPEED_MS = 10
const GRADE_PCT = 1.5
const MASS_KG = 75
const VO2_EST = 35.8
const CORE_TEMP = 37.4

const powerFor = (step: number): number => 200 + step * 40
const heartRateFor = (step: number): number => 120 + step * 15

export function fixtureProtocol(): Protocol {
  return makeProtocol(
    'Step test',
    'bike',
    Array.from({ length: STEPS }, (_, step) => ({
      id: `step_${step}`,
      name: `Step ${step + 1}`,
      durationS: SAMPLES_PER_STEP,
      target: { mode: 'watts' as const, watts: powerFor(step) },
    })),
  )
}

export function fixtureSession(): SessionRecord {
  const samples: Sample[] = []
  for (let t = 0; t < STEPS * SAMPLES_PER_STEP; t++) {
    const step = Math.floor(t / SAMPLES_PER_STEP)
    samples.push({
      t,
      stepIndex: step,
      phase: 'work',
      power: powerFor(step),
      targetPower: powerFor(step),
      heartRate: heartRateFor(step),
      cadence: 90,
      speedMs: SPEED_MS,
      distanceM: t * SPEED_MS,
      inclinePct: GRADE_PCT,
      vo2Est: VO2_EST,
      vo2Method: 'acsmBike',
      coreTempC: CORE_TEMP,
    })
  }

  return {
    id: 'session_fixture',
    protocolId: fixtureProtocol().id,
    protocolName: 'Step test',
    sport: 'bike',
    athlete: { name: 'P-FIXTURE', massKg: MASS_KG, ftpWatts: 300 },
    startedAt: START,
    endedAt: START + samples.length * 1000,
    samples,
    lactate: [
      { stepIndex: 0, mmol: 1.2, rpe: 11, at: START },
      { stepIndex: 1, mmol: 2.4, rpe: 14, at: START },
      { stepIndex: 2, mmol: 4.8, rpe: 17, at: START },
    ],
  }
}

export const fixtureLaps = () => {
  const session = fixtureSession()
  return lapsFromSamples(session.samples, fixtureProtocol(), session.athlete, session.lactate)
}

/** Energy per sample, from the recorded oxygen estimate. */
const KCAL_PER_SAMPLE = ((VO2_EST * MASS_KG) / 1000) * 5 * (1 / 60)
const TOTAL_SAMPLES = STEPS * SAMPLES_PER_STEP
/** Distance between the first and last sample of a lap, not across its start. */
const LAP_DISTANCE = (SAMPLES_PER_STEP - 1) * SPEED_MS
const TOTAL_DISTANCE = (TOTAL_SAMPLES - 1) * SPEED_MS
/** Vertical metres, quantised by the altitude field's 0.2 m resolution. */
const TOTAL_CLIMB = Math.round((TOTAL_DISTANCE * (GRADE_PCT / 100) + 500) * 5) / 5 - 500

/**
 * What `fitdecode`, carrying Garmin's own profile, should report.
 *
 * Field *names* here rather than numbers, deliberately: that is the whole point
 * of checking against the profile. If a number in the encoder means something
 * other than what it was meant to mean, it resolves to a different name and
 * this stops matching.
 */
export const fixtureExpectations = {
  appName: APP_NAME,
  appVersion: APP_VERSION,
  sport: 'cycling',
  subSport: 'indoor_cycling',

  counts: {
    file_id: 1,
    file_creator: 1,
    developer_data_id: 1,
    field_description: 9,
    sport: 1,
    event: 2,
    record: TOTAL_SAMPLES,
    lap: STEPS,
    session: 1,
    activity: 1,
  },

  firstRecord: {
    heart_rate: heartRateFor(0),
    cadence: 90,
    power: powerFor(0),
    speed: SPEED_MS,
    distance: 0,
    grade: GRADE_PCT,
    altitude: 0,
  },

  lastRecord: {
    heart_rate: heartRateFor(STEPS - 1),
    power: powerFor(STEPS - 1),
    speed: SPEED_MS,
    distance: TOTAL_DISTANCE,
    grade: GRADE_PCT,
    altitude: TOTAL_CLIMB,
  },

  /** Units come from the profile, so a wrong field number shows up here too. */
  recordUnits: {
    heart_rate: 'bpm',
    cadence: 'rpm',
    power: 'watts',
    speed: 'm/s',
    distance: 'm',
    grade: '%',
    altitude: 'm',
  },

  /**
   * `null` where the field genuinely has no units. FIT's invalid value for a
   * string is a zero byte, so an empty units string is the field saying it is
   * absent, and a conforming decoder reports it as absent rather than as an
   * empty string. That is the right encoding for a dimensionless flag, and the
   * expectation follows the format rather than the other way round.
   */
  developerFields: {
    target_power: { units: 'watts' },
    vo2_estimate: { units: 'mL/kg/min' },
    vo2_method: { units: null },
    core_temperature: { units: 'degC' },
    grade_is_commanded: { units: null },
    distance_is_integrated: { units: null },
    blood_lactate: { units: 'mmol/L' },
    rpe_borg: { units: null },
    step_target: { units: null },
  },

  firstRecordDev: {
    target_power: powerFor(0),
    vo2_estimate: VO2_EST,
    // The equation travels with the number, always.
    vo2_method: 'acsmBike',
    core_temperature: CORE_TEMP,
    // Measured, not assumed. The flag is written either way so the two cannot
    // be confused with the field simply being absent.
    grade_is_commanded: 0,
    distance_is_integrated: 0,
  },

  laps: Array.from({ length: STEPS }, (_, step) => ({
    message_index: step,
    total_elapsed_time: SAMPLES_PER_STEP,
    total_timer_time: SAMPLES_PER_STEP,
    total_distance: LAP_DISTANCE,
    total_calories: Math.round(KCAL_PER_SAMPLE * SAMPLES_PER_STEP),
    avg_power: powerFor(step),
    max_power: powerFor(step),
    avg_heart_rate: heartRateFor(step),
    max_heart_rate: heartRateFor(step),
    avg_cadence: 90,
    avg_speed: SPEED_MS,
    blood_lactate: [1.2, 2.4, 4.8][step],
    rpe_borg: [11, 14, 17][step],
    step_target: `${powerFor(step)} W`,
  })),

  session: {
    sport: 'cycling',
    sub_sport: 'indoor_cycling',
    // Sampling starts at t = 0, so the elapsed time is one interval longer
    // than the last timestamp. The TCX writer this replaced got it the other
    // way and declared 899 s for 900 recorded seconds.
    total_elapsed_time: TOTAL_SAMPLES,
    total_timer_time: TOTAL_SAMPLES,
    total_distance: TOTAL_DISTANCE,
    total_calories: Math.round(KCAL_PER_SAMPLE * TOTAL_SAMPLES),
    avg_heart_rate: heartRateFor(1),
    max_heart_rate: heartRateFor(STEPS - 1),
    avg_cadence: 90,
    avg_power: powerFor(1),
    max_power: powerFor(STEPS - 1),
    avg_speed: SPEED_MS,
    max_speed: SPEED_MS,
    num_laps: STEPS,
    first_lap_index: 0,
  },
}
