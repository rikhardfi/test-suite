import type { Lap, SessionRecord } from './session'

/** One row per recorded second, for a spreadsheet or R/Python. */
export function samplesToCsv(session: SessionRecord): string {
  const header = [
    'elapsed_s',
    'step_index',
    'phase',
    'power_w',
    'target_power_w',
    'heart_rate_bpm',
    'cadence_rpm',
    'speed_ms',
    'speed_kph',
    'pace_s_per_km',
  ]
  const rows = session.samples.map((s) =>
    [
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
    ].join(','),
  )
  return [header.join(','), ...rows].join('\n')
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
    'lactate_mmol',
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
      lap.lactate ?? '',
    ].join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

export const sessionToJson = (session: SessionRecord): string => JSON.stringify(session, null, 2)

/**
 * TCX with a trackpoint per second. Chosen over FIT because it is text, is
 * accepted by TrainingPeaks, Golden Cheetah and Strava, and carries power and
 * cadence in the extension namespace those tools already read.
 */
export function sessionToTcx(session: SessionRecord): string {
  const start = new Date(session.startedAt)
  const sport = session.sport === 'run' ? 'Running' : 'Biking'
  let distance = 0

  const trackpoints = session.samples
    .map((s, index) => {
      const previous = index > 0 ? session.samples[index - 1] : null
      const dt = previous ? s.t - previous.t : 0
      if (s.speedMs) distance += s.speedMs * dt

      const time = new Date(session.startedAt + s.t * 1000).toISOString()
      const parts = [
        `        <Trackpoint>`,
        `          <Time>${time}</Time>`,
        `          <DistanceMeters>${distance.toFixed(1)}</DistanceMeters>`,
      ]
      if (s.heartRate != null) {
        parts.push(
          `          <HeartRateBpm><Value>${Math.round(s.heartRate)}</Value></HeartRateBpm>`,
        )
      }
      if (s.cadence != null) parts.push(`          <Cadence>${Math.round(s.cadence)}</Cadence>`)
      if (s.power != null || s.speedMs != null) {
        parts.push(
          `          <Extensions><ns3:TPX>`,
          s.speedMs != null ? `            <ns3:Speed>${s.speedMs.toFixed(2)}</ns3:Speed>` : '',
          s.power != null ? `            <ns3:Watts>${Math.round(s.power)}</ns3:Watts>` : '',
          `          </ns3:TPX></Extensions>`,
        )
      }
      parts.push(`        </Trackpoint>`)
      return parts.filter(Boolean).join('\n')
    })
    .join('\n')

  const totalSeconds = session.samples.length ? session.samples[session.samples.length - 1].t : 0

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${start.toISOString()}</Id>
      <Lap StartTime="${start.toISOString()}">
        <TotalTimeSeconds>${totalSeconds}</TotalTimeSeconds>
        <DistanceMeters>${distance.toFixed(1)}</DistanceMeters>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${trackpoints}
        </Track>
      </Lap>
      <Notes>${escapeXml(session.protocolName)}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
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

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' }[c]};`)
