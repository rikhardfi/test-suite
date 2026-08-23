import type { SessionRecord, Sample } from './session'
import type { Protocol } from './protocol'
import { VO2_METHODS } from './vo2'
import type { JournalEvent, JournalRecord } from './journal'

/**
 * The research export: a frozen CSV contract plus a sidecar that says what the
 * columns mean.
 *
 * FIT and TCX are activity-exchange formats. They are lossy by design, they
 * encode assumptions about what a workout is, and neither carries the
 * provenance a reviewer would ask for. Neither is a research format, and this
 * module exists because pretending otherwise is how a dataset becomes
 * uninterpretable a year later, which is exactly when it gets analysed.
 *
 * Three commitments here:
 *
 * 1. **The column contract is frozen and tested.** Columns may be appended;
 *    they are never renamed, reordered or given new units. An analysis script
 *    written against last year's export must still run.
 * 2. **Every derived number carries its method and the code version.** A
 *    threshold, a critical power, an oxygen estimate: each is the result of a
 *    choice that could reasonably have been made differently, and a number
 *    whose method is not recorded is repeatable but not reproducible.
 * 3. **No identifiers.** A participant code, never a name, and the mapping
 *    never leaves the machine it was made on.
 */

/** Bumped when a column is appended. Never on a rename, because there are none. */
export const RESEARCH_EXPORT_VERSION = 2

export interface ColumnSpec {
  name: string
  unit: string
  description: string
  /** The `Sample` property it comes from, where it maps to one directly. */
  from?: keyof Sample
}

/**
 * The sample CSV, column for column and unit for unit.
 *
 * This list is the contract. Appending is safe; anything else breaks a script
 * somebody has already written.
 */
export const SAMPLE_COLUMNS: readonly ColumnSpec[] = [
  { name: 'elapsed_s', unit: 's', description: 'Seconds since the session started', from: 't' },
  { name: 'step_index', unit: '', description: 'Zero-based protocol step', from: 'stepIndex' },
  { name: 'phase', unit: '', description: 'work or break', from: 'phase' },
  { name: 'power_w', unit: 'W', description: 'Measured mechanical power', from: 'power' },
  {
    name: 'target_power_w',
    unit: 'W',
    description:
      'Power the protocol asked the athlete for. Where a power correction was running this is NOT what the trainer was told to do; see commanded_power_w',
    from: 'targetPower',
  },
  { name: 'heart_rate_bpm', unit: 'bpm', description: 'Heart rate', from: 'heartRate' },
  { name: 'cadence_rpm', unit: 'rpm or spm', description: 'Pedal or step rate, by sport', from: 'cadence' },
  { name: 'speed_ms', unit: 'm/s', description: 'Measured speed', from: 'speedMs' },
  { name: 'speed_kph', unit: 'km/h', description: 'Measured speed, derived from speed_ms' },
  { name: 'pace_s_per_km', unit: 's/km', description: 'Derived from speed_ms; blank below 0.1 m/s' },
  { name: 'incline_pct', unit: '%', description: 'Treadmill gradient', from: 'inclinePct' },
  {
    name: 'incline_source',
    unit: '',
    description: 'measured when the machine reported it, commanded when it was assumed from the target',
  },
  { name: 'distance_m', unit: 'm', description: 'Cumulative distance', from: 'distanceM' },
  {
    name: 'distance_source',
    unit: '',
    description: 'machine when read from the odometer, integrated when accumulated from speed',
  },
  { name: 'resistance', unit: '', description: 'Trainer resistance level', from: 'resistance' },
  { name: 'target_incline_pct', unit: '%', description: 'Gradient commanded', from: 'targetInclinePct' },
  {
    name: 'vo2_est_ml_kg_min',
    unit: 'mL/kg/min',
    description: 'ESTIMATED oxygen cost from a population regression, not a measurement',
    from: 'vo2Est',
  },
  {
    name: 'vo2_method',
    unit: '',
    description: 'Which equation produced vo2_est_ml_kg_min; see methods in the sidecar',
    from: 'vo2Method',
  },
  { name: 'core_temp_c', unit: 'degC', description: 'CORE estimated core temperature', from: 'coreTempC' },
  { name: 'skin_temp_c', unit: 'degC', description: 'CORE skin temperature', from: 'skinTempC' },
  { name: 'heat_strain_index', unit: '', description: 'CORE heat strain index, 0 to 25.4', from: 'heatStrainIndex' },
  { name: 'core_quality', unit: '', description: '0 invalid, 1 poor, 2 fair, 3 good, 4 excellent', from: 'coreQuality' },
  {
    name: 'core_hrm_state',
    unit: '',
    description: '0 unsupported, 1 supported but not receiving, 2 receiving',
    from: 'coreHrmState',
  },
  {
    name: 'power_secondary_w',
    unit: 'W',
    description:
      "Controllable machine's own power, recorded when a separate reference meter supplied power_w. Never blended into power_w",
    from: 'powerSecondaryW',
  },
  {
    name: 'commanded_power_w',
    unit: 'W',
    description:
      'What the machine was actually told to do, where a correction made that differ from target_power_w. Blank means the raw target was commanded',
    from: 'commandedPower',
  },
  {
    name: 'power_match_factor',
    unit: '',
    description: 'Correction in force: commanded_power_w = target_power_w x this. Blank means none',
    from: 'powerMatchFactor',
  },
  {
    name: 'power_match_held',
    unit: '',
    description:
      '1 when the reference meter was not reporting and the last known correction was held. The step is uncorrected in that stretch',
  },
]

// --- provenance -------------------------------------------------------------

/** A derived number, with the choice that produced it attached. */
export interface Derivation {
  value: number | null
  method: string
  /** What the method is, said plainly, for a reader who does not know it. */
  note?: string
  /** Version of the code that computed it. */
  computedBy: string
}

export const derive = (
  value: number | null,
  method: string,
  appVersion: string,
  note?: string,
): Derivation => ({ value, method, note, computedBy: `testday ${appVersion}` })

// --- pseudonyms -------------------------------------------------------------

/**
 * A stable, non-reversible code for an athlete.
 *
 * The name never reaches an export, a filename or a journal that leaves this
 * machine. The mapping from code back to person is the operator's to keep, off
 * to one side, and this function deliberately cannot undo itself.
 *
 * This is not a security control. It is the difference between a spreadsheet
 * that can sit in a shared folder and one that cannot.
 */
export function participantCode(name: string, salt: string): string {
  const input = `${salt}:${name.trim().toLowerCase()}`
  // FNV-1a, 32 bit, run twice over different seeds for a longer code. Enough to
  // avoid collisions in a lab's worth of athletes and no more than that.
  const hash = (seed: number): number => {
    let h = seed
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }
  const a = hash(0x811c9dc5).toString(36).padStart(7, '0')
  const b = hash(0x9e3779b9).toString(36).padStart(7, '0')
  return `P-${(a + b).slice(0, 10).toUpperCase()}`
}

/** Strips anything that could name the athlete, for an export that leaves the machine. */
export function pseudonymise(session: SessionRecord, salt: string): SessionRecord {
  return {
    ...session,
    athlete: { ...session.athlete, name: participantCode(session.athlete.name, salt) },
  }
}

// --- the sidecar ------------------------------------------------------------

export interface SidecarOptions {
  appVersion: string
  protocol?: Protocol
  /** Journal events, which are how the protocol as executed is reconstructed. */
  events?: readonly JournalRecord[]
  /** Named devices that contributed, where the app knows them. */
  devices?: { id: string; name: string; kind: string; firmware?: string }[]
  salt?: string
}

/**
 * Written beside every research export. Without it the CSV is a grid of numbers
 * whose units, provenance and sampling rates have to be guessed.
 */
export function researchSidecar(session: SessionRecord, options: SidecarOptions): string {
  const salt = options.salt ?? ''
  const executed = executionLog(options.events ?? [])

  return JSON.stringify(
    {
      format: 'testday-research-export',
      formatVersion: RESEARCH_EXPORT_VERSION,
      generatedBy: `testday ${options.appVersion}`,

      session: {
        id: session.id,
        // A code, never a name. See `participantCode`.
        participant: participantCode(session.athlete.name, salt),
        sport: session.sport,
        startedAt: new Date(session.startedAt).toISOString(),
        endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
        sampleCount: session.samples.length,
        rrRecordCount: session.rr?.length ?? 0,
      },

      athlete: {
        // Body mass and threshold power are inputs to the derived numbers, so
        // they have to travel with the data. They do not identify anyone.
        massKg: session.athlete.massKg,
        ftpWatts: session.athlete.ftpWatts,
        maxHr: session.athlete.maxHr ?? null,
        restingHr: session.athlete.restingHr ?? null,
        economyPct: session.athlete.economyPct ?? null,
        vo2maxMlKgMin: session.athlete.vo2maxMlKgMin ?? null,
      },

      sampling: {
        derivedSeriesHz: 1,
        note:
          'The CSV is a 1 Hz derived series. The journal also holds every sensor ' +
          'notification at its own native rate, which is not resampled and is not ' +
          'in this file.',
      },

      columns: SAMPLE_COLUMNS.map((column) => ({
        name: column.name,
        unit: column.unit,
        description: column.description,
      })),

      devices: options.devices ?? [],

      /**
       * Conditions, on their own clock and with their provenance. Recorded
       * because a result without them cannot be read properly a year later:
       * cold, dry or CO₂-loaded indoor air is a conditioning load the airway
       * carries, not context around the measurement.
       */
      environment: (session.environment ?? []).map((reading) => ({
        at: new Date(reading.at).toISOString(),
        tempC: reading.tempC ?? null,
        humidityPct: reading.humidityPct ?? null,
        co2Ppm: reading.co2Ppm ?? null,
        pressureHpa: reading.pressureHpa ?? null,
        altitudeM: reading.altitudeM ?? null,
        setting: reading.setting ?? null,
        note: reading.note ?? null,
        source: reading.source,
      })),

      methods: {
        vo2: Object.entries(VO2_METHODS).map(([key, info]) => ({
          id: key,
          label: info.label,
          equation: info.note,
          validatedRange: `${info.validFrom} to ${info.validTo} ${info.validUnit}`,
          kind: 'population regression, not a measurement',
        })),
      },

      protocolAsWritten: options.protocol
        ? {
            id: options.protocol.id,
            name: options.protocol.name,
            sport: options.protocol.sport,
            steps: options.protocol.steps.map((step, index) => ({
              index,
              name: step.name ?? `Step ${index + 1}`,
              durationS: step.durationS,
              recoveryS: step.recoveryS ?? 0,
              target: step.target,
            })),
          }
        : null,

      // The two diverge the moment anyone trims intensity or skips a stage, and
      // afterwards only this can say which happened.
      protocolAsExecuted: executed,

      caveats: [
        'vo2_est_ml_kg_min is estimated from a population regression and is not a measured VO2.',
        'incline_source and distance_source distinguish a measurement from an assumption.',
        'A blank cell means the metric was not reported, which is not the same as zero.',
        'Environment readings carry their own timestamps and are not resampled onto the 1 Hz clock.',
      ],
    },
    null,
    2,
  )
}

/** The operator's actions, in order, as a plain list. */
function executionLog(records: readonly JournalRecord[]): {
  at: string
  action: string
  detail?: Record<string, number | string | boolean>
}[] {
  return records
    .filter((record): record is JournalEvent => record.type === 'event')
    .map((event) => ({
      at: new Date(event.at).toISOString(),
      action: event.kind,
      detail: event.data,
    }))
}
