import type { Lap, Sample, SessionRecord } from './session'
import { SAMPLE_COLUMNS } from './research'

/**
 * One row per recorded second, for a spreadsheet or R/Python.
 *
 * The header comes from `SAMPLE_COLUMNS` rather than being written out here, so
 * the documented contract and the file cannot drift apart. A test asserts the
 * row width matches the column count, which is what catches a column added to
 * one and not the other.
 */
export function samplesToCsv(session: SessionRecord): string {
  const rows = session.samples.map((s) => sampleRow(s).join(','))
  return [SAMPLE_COLUMNS.map((c) => c.name).join(','), ...rows].join('\n')
}

/** One row, in `SAMPLE_COLUMNS` order. Blank means not reported, never zero. */
export function sampleRow(s: Sample): (string | number)[] {
  return [
    s.t,
    s.stepIndex,
    s.phase,
    s.power ?? '',
    s.targetPower ?? '',
    s.heartRate ?? '',
    s.cadence ?? '',
    s.speedMs?.toFixed(2) ?? '',
    s.speedMs ? (s.speedMs * 3.6).toFixed(2) : '',
    s.speedMs && s.speedMs > 0.1 ? Math.round(1000 / s.speedMs) : '',
    s.inclinePct?.toFixed(1) ?? '',
    s.inclinePct == null ? '' : s.inclineFromTarget ? 'commanded' : 'measured',
    s.distanceM?.toFixed(1) ?? '',
    s.distanceM == null ? '' : s.distanceIntegrated ? 'integrated' : 'machine',
    s.resistance ?? '',
    s.targetInclinePct?.toFixed(1) ?? '',
    s.vo2Est?.toFixed(2) ?? '',
    s.vo2Method ?? '',
    s.coreTempC?.toFixed(2) ?? '',
    s.skinTempC?.toFixed(2) ?? '',
    s.heatStrainIndex?.toFixed(1) ?? '',
    s.coreQuality ?? '',
    s.coreHrmState ?? '',
    s.powerSecondaryW ?? '',
    s.commandedPower ?? '',
    s.powerMatchFactor ?? '',
    s.powerMatchHeld ? 1 : '',
    s.exhaledFlowLMin?.toFixed(3) ?? '',
    s.exhaledGasTempC?.toFixed(2) ?? '',
    s.exhaledRhPct?.toFixed(1) ?? '',
    s.exhaledCoverage?.toFixed(2) ?? '',
  ]
}

/** Step-level summary, which is what actually goes into a test report. */
export function lapsToCsv(laps: readonly Lap[]): string {
  const header = [
    'step',
    'name',
    'target',
    'target_w',
    'duration_s',
    'avg_power_w',
    'max_power_w',
    'avg_hr_bpm',
    'max_hr_bpm',
    'avg_cadence_rpm',
    'avg_speed_kph',
    'avg_incline_pct',
    'distance_m',
    'normalized_power_w',
    'work_kj',
    'kcal',
    'avg_vo2_ml_kg_min',
    'lactate_mmol',
    'rpe_borg',
  ]
  const rows = laps.map((lap) =>
    [
      lap.stepIndex + 1,
      quote(lap.name),
      quote(lap.target),
      lap.targetWatts ?? '',
      lap.durationS,
      lap.avgPower ?? '',
      lap.maxPower ?? '',
      lap.avgHeartRate ?? '',
      lap.maxHeartRate ?? '',
      lap.avgCadence ?? '',
      lap.avgSpeedMs ? (lap.avgSpeedMs * 3.6).toFixed(2) : '',
      lap.avgInclinePct ?? '',
      lap.distanceM ?? '',
      lap.normalizedPower != null ? Math.round(lap.normalizedPower) : '',
      lap.workKj ?? '',
      lap.kcal ?? '',
      lap.avgVo2 ?? '',
      lap.lactate ?? '',
      lap.rpe ?? '',
    ].join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

export const sessionToJson = (session: SessionRecord): string => JSON.stringify(session, null, 2)

export function download(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

/** Text built in pieces, so a long high-rate export is never one giant string. */
export function downloadParts(filename: string, parts: string[], mime: string): void {
  downloadBlob(filename, new Blob(parts, { type: mime }))
}

/** The same, for a binary format. FIT is bytes, not text. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  downloadBlob(filename, new Blob([bytes as BlobPart], { type: mime }))
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // Revoke on the next frame so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function sessionFilename(session: SessionRecord, extension: string): string {
  const date = new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const slug = session.protocolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${date}_${slug || 'test'}.${extension}`
}

const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`
