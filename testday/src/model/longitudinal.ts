import { analyseLactateWithBands, criticalPower, type ThresholdBand } from './analysis'
import { mmpCurve } from './metrics'
import { lapsFromSamples, type SessionRecord } from './session'
import type { Protocol } from './protocol'

/**
 * One athlete across test days.
 *
 * The reason this exists is the reason the shelved item gave: an athlete's
 * result is only interpretable against their own history. Athletes sit
 * systematically above population reference ranges, so a value comfortably
 * inside the normal range can already be a decline, and the only thing that
 * shows it is the same athlete measured before.
 *
 * Everything here is pure and works on sessions already read from disk.
 */

export interface SessionThresholds {
  sessionId: string
  startedAt: number
  protocolName: string
  sport: SessionRecord['sport']
  /** Points as they went into the fit, so a chart can draw the raw curve too. */
  points: { intensity: number; lactate: number; heartRate?: number }[]
  thresholds: ThresholdBand[]
  cpWatts: number | null
  mmp: { durationS: number; watts: number }[]
  /** Conditions, where they were recorded. */
  environment?: { tempC?: number; humidityPct?: number; co2Ppm?: number }
}

/**
 * Which sessions belong to the same athlete.
 *
 * Matched on the name as recorded, which after pseudonymisation is the
 * participant code. Deliberately not fuzzy: two spellings of a name are two
 * athletes as far as this is concerned, because silently merging them would
 * produce a history that never happened.
 */
export const athleteKey = (session: SessionRecord): string =>
  session.athlete.name.trim().toLowerCase()

export function summariseSession(
  session: SessionRecord,
  protocols: readonly Protocol[],
): SessionThresholds {
  const protocol = protocols.find((p) => p.id === session.protocolId)
  const isRun = session.sport === 'run'

  const laps = protocol
    ? lapsFromSamples(session.samples, protocol, session.athlete, session.lactate)
    : []

  const points = session.lactate
    .filter((entry) => !entry.removed)
    .flatMap((entry) => {
      const lap = laps[entry.stepIndex]
      const intensity = isRun
        ? lap?.avgSpeedMs
          ? lap.avgSpeedMs * 3.6
          : null
        : (lap?.avgPower ?? lap?.targetWatts ?? null)
      if (intensity == null) return []
      return [
        {
          intensity,
          lactate: entry.mmol,
          heartRate: entry.heartRate ?? lap?.avgHeartRate ?? undefined,
        },
      ]
    })

  const power = session.samples.map((s) => s.power ?? 0)
  const curve = mmpCurve(power)
  const last = session.environment?.[session.environment.length - 1]

  return {
    sessionId: session.id,
    startedAt: session.startedAt,
    protocolName: session.protocolName,
    sport: session.sport,
    points,
    thresholds: analyseLactateWithBands(points),
    cpWatts: criticalPower(curve)?.cpWatts ?? null,
    mmp: curve,
    environment: last
      ? { tempC: last.tempC, humidityPct: last.humidityPct, co2Ppm: last.co2Ppm }
      : undefined,
  }
}

export interface TrendPoint {
  startedAt: number
  sessionId: string
  intensity: number
  low: number | null
  high: number | null
  unstable: boolean
}

/**
 * One method's estimate across test days, oldest first.
 *
 * The band travels with each point, because a trend drawn through six point
 * estimates looks like a trend whether or not the individual estimates could
 * support one. A rise of ten watts between two tests whose bands are forty
 * watts wide is not a rise.
 */
export function trendFor(sessions: readonly SessionThresholds[], method: string): TrendPoint[] {
  return sessions
    .map((session) => {
      const band = session.thresholds.find((t) => t.method === method)
      if (!band || band.intensity == null) return null
      return {
        startedAt: session.startedAt,
        sessionId: session.sessionId,
        intensity: band.intensity,
        low: band.lowIntensity,
        high: band.highIntensity,
        unstable: band.unstable,
      }
    })
    .filter((point): point is TrendPoint => point !== null)
    .sort((a, b) => a.startedAt - b.startedAt)
}

export interface TrendVerdict {
  changed: boolean
  deltaPct: number
  /** Said in words, including when the change is smaller than the uncertainty. */
  summary: string
}

/**
 * Whether a change between the first and last test says anything.
 *
 * The bands decide. If they overlap, the honest answer is that the test cannot
 * tell, and that is what this returns, because the alternative is a percentage
 * that reads as a finding.
 */
export function judgeTrend(points: readonly TrendPoint[]): TrendVerdict | null {
  if (points.length < 2) return null
  const first = points[0]
  const last = points[points.length - 1]
  const deltaPct = ((last.intensity - first.intensity) / first.intensity) * 100

  const firstLow = first.low ?? first.intensity
  const firstHigh = first.high ?? first.intensity
  const lastLow = last.low ?? last.intensity
  const lastHigh = last.high ?? last.intensity
  const overlap = lastLow <= firstHigh && firstLow <= lastHigh

  if (overlap) {
    return {
      changed: false,
      deltaPct,
      summary: `${deltaPct >= 0 ? 'Up' : 'Down'} ${Math.abs(deltaPct).toFixed(1)}%, but the leave-one-out ranges overlap. This test cannot tell the two apart.`,
    }
  }

  return {
    changed: true,
    deltaPct,
    summary: `${deltaPct >= 0 ? 'Up' : 'Down'} ${Math.abs(deltaPct).toFixed(1)}% against this athlete's own earlier test, beyond the range either estimate could account for.`,
  }
}
