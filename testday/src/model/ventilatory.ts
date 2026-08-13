import { linearFit } from './analysis'

/**
 * Ventilatory thresholds from a metabolic cart export.
 *
 * Two reasons this is worth having. The first is the one the shelved item gave:
 * VT1 and VT2 placed beside the lactate thresholds is the comparison that makes
 * both interpretable, and neither alone says what the other does.
 *
 * The second is that this is the only way the app's own VO₂ estimates ever get
 * checked. They come from population regressions; a cart measures. Importing a
 * cart file for a session the app also recorded puts the estimate and the
 * measurement on the same clock, which is the comparison that would falsify the
 * estimate if it deserves falsifying.
 *
 * Everything here is pure.
 */

export interface CartSample {
  /** Seconds from the start of the cart recording. */
  t: number
  /** Minute ventilation, L/min. */
  ve?: number
  /** Oxygen uptake, mL/min. */
  vo2?: number
  /** Carbon dioxide output, mL/min. */
  vco2?: number
  heartRate?: number
  /** Respiratory exchange ratio, where the cart reports it rather than VCO₂/VO₂. */
  rer?: number
}

/**
 * Column aliases, because no two carts agree on a header.
 *
 * Matching is case-insensitive and ignores spaces, dots and units in brackets,
 * so "VO2 (mL/min)", "v'o2" and "VO2_STPD" all land in the same place.
 */
const COLUMN_ALIASES: Record<keyof Omit<CartSample, 't'> | 't', string[]> = {
  t: ['t', 'time', 'tid', 'aika', 'elapsed', 'elapsedtime'],
  ve: ['ve', 'vebtps', 'vel', 'minuteventilation', 'ventilation'],
  vo2: ['vo2', 'vo2stpd', 'vo2mlmin', 'o2uptake'],
  vco2: ['vco2', 'vco2stpd', 'co2output'],
  heartRate: ['hr', 'heartrate', 'syke', 'pulse', 'bpm'],
  rer: ['rer', 'rq', 'respiratoryexchangeratio'],
}

const normalise = (header: string): string =>
  header
    .toLowerCase()
    .replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/[^a-z0-9]/g, '')

/**
 * Time can be seconds, or mm:ss, or hh:mm:ss. A cart that writes 12:30 means
 * twelve and a half minutes, not twelve hours.
 */
function parseTime(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map(Number)
    if (parts.some((n) => !Number.isFinite(n))) return null
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return null
  }
  const parsed = Number(trimmed.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

export interface CartImport {
  samples: CartSample[]
  /** Headers that were understood, so the operator can see what was read. */
  matched: Partial<Record<keyof CartSample, string>>
  /** Headers that were not, so a missing column is visible rather than silent. */
  ignored: string[]
}

/**
 * Reads a cart export.
 *
 * Deliberately reports which columns it understood and which it skipped. A
 * silent import that quietly found no VCO₂ column would produce a file with no
 * VT1 and no explanation, and the operator would be left guessing whether the
 * threshold is absent or the import is.
 */
export function parseCartCsv(text: string): CartImport {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return { samples: [], matched: {}, ignored: [] }

  const delimiter = countOf(lines[0], ';') > countOf(lines[0], ',') ? ';' : ','
  const headers = lines[0].split(delimiter).map((h) => h.trim())

  const matched: Partial<Record<keyof CartSample, string>> = {}
  const columnFor: Partial<Record<keyof CartSample, number>> = {}
  const used = new Set<number>()

  for (const [key, aliases] of Object.entries(COLUMN_ALIASES) as [keyof CartSample, string[]][]) {
    const index = headers.findIndex((h, i) => !used.has(i) && aliases.includes(normalise(h)))
    if (index === -1) continue
    columnFor[key] = index
    matched[key] = headers[index]
    used.add(index)
  }

  const ignored = headers.filter((_h, i) => !used.has(i))

  const samples: CartSample[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter)
    const t = columnFor.t != null ? parseTime(cells[columnFor.t] ?? '') : samples.length
    if (t == null) continue

    const value = (key: keyof CartSample): number | undefined => {
      const index = columnFor[key]
      if (index == null) return undefined
      const parsed = Number((cells[index] ?? '').trim().replace(',', '.'))
      return Number.isFinite(parsed) ? parsed : undefined
    }

    samples.push({
      t,
      ve: value('ve'),
      vo2: value('vo2'),
      vco2: value('vco2'),
      heartRate: value('heartRate'),
      rer: value('rer'),
    })
  }

  return { samples, matched, ignored }
}

// --- breakpoints ------------------------------------------------------------

export interface Breakpoint {
  /** Index of the sample where the two segments meet. */
  index: number
  x: number
  y: number
  slopeBefore: number
  slopeAfter: number
  /** Residual sum of squares of the two-segment fit, for comparing candidates. */
  rss: number
}

/**
 * Best two-segment fit through a scatter, by exhaustive search over the join.
 *
 * Exhaustive because there are a few hundred breaths in a test and the search
 * is over a single index. An optimiser would be faster and would occasionally
 * find a different local minimum, which is not a trade worth making for a
 * number somebody is going to publish.
 */
export function twoSegmentBreakpoint(
  x: readonly number[],
  y: readonly number[],
  minSegment = 10,
): Breakpoint | null {
  const n = Math.min(x.length, y.length)
  if (n < minSegment * 2) return null

  let best: Breakpoint | null = null

  for (let split = minSegment; split <= n - minSegment; split++) {
    try {
      const left = linearFit(x.slice(0, split), y.slice(0, split))
      const right = linearFit(x.slice(split), y.slice(split))
      const rss = sse(x.slice(0, split), y.slice(0, split), left) + sse(x.slice(split), y.slice(split), right)
      if (!Number.isFinite(rss)) continue
      if (!best || rss < best.rss) {
        best = {
          index: split,
          x: x[split],
          y: y[split],
          slopeBefore: left.slope,
          slopeAfter: right.slope,
          rss,
        }
      }
    } catch {
      // A degenerate segment, e.g. every x identical. Skip that split.
    }
  }

  return best
}

const sse = (
  x: readonly number[],
  y: readonly number[],
  fit: { slope: number; intercept: number },
): number => {
  let total = 0
  for (let i = 0; i < x.length; i++) {
    const residual = y[i] - (fit.slope * x[i] + fit.intercept)
    total += residual * residual
  }
  return total
}

// --- thresholds -------------------------------------------------------------

export interface VentilatoryThreshold {
  label: string
  method: string
  /** Seconds into the cart recording. */
  t: number
  vo2: number | null
  heartRate: number | null
  note: string
}

export interface VentilatoryResult {
  vt1: VentilatoryThreshold | null
  vt2: VentilatoryThreshold | null
  /** Said plainly when one or both could not be found, rather than left blank. */
  problems: string[]
}

/** A rolling mean, because breath-by-breath data is far too noisy to fit raw. */
function smooth(values: readonly (number | undefined)[], window: number): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - Math.floor(window / 2))
    const to = Math.min(values.length, from + window)
    const slice = values.slice(from, to).filter((v): v is number => v != null && Number.isFinite(v))
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null)
  }
  return out
}

/**
 * VT1 by the V-slope method and VT2 by the ventilatory equivalent for CO₂.
 *
 * VT1 is the breakpoint in VCO₂ against VO₂, where the slope crosses one:
 * below it, CO₂ output tracks oxygen uptake; above it, buffering adds CO₂ that
 * oxygen uptake does not account for. VT2 is where VE/VCO₂ stops being flat and
 * starts to climb, which is respiratory compensation.
 *
 * Both are estimates from a fit, and the fit is over noisy data, so a
 * breakpoint that the search found but that the slopes do not support is
 * reported as a problem rather than as a threshold.
 */
export function ventilatoryThresholds(
  samples: readonly CartSample[],
  smoothingWindow = 15,
): VentilatoryResult {
  const problems: string[] = []

  const usable = samples.filter((s) => s.vo2 != null && s.vco2 != null)
  if (usable.length < 30) {
    return {
      vt1: null,
      vt2: null,
      problems: [
        usable.length === 0
          ? 'No VO₂ and VCO₂ columns were found, so neither threshold can be computed.'
          : `Only ${usable.length} breaths carry both VO₂ and VCO₂; at least 30 are needed.`,
      ],
    }
  }

  const vo2 = smooth(usable.map((s) => s.vo2), smoothingWindow)
  const vco2 = smooth(usable.map((s) => s.vco2), smoothingWindow)
  const ve = smooth(usable.map((s) => s.ve), smoothingWindow)

  const keep = vo2.map((v, i) => v != null && vco2[i] != null).map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0)
  const xs = keep.map((i) => vo2[i] as number)
  const ys = keep.map((i) => vco2[i] as number)

  // --- VT1: V-slope ---
  const vSlope = twoSegmentBreakpoint(xs, ys)
  let vt1: VentilatoryThreshold | null = null
  if (!vSlope) {
    problems.push('No V-slope breakpoint was found in VCO₂ against VO₂.')
  } else if (!(vSlope.slopeAfter > vSlope.slopeBefore)) {
    // The search always returns its best split. A "breakpoint" where the slope
    // falls is not VT1, it is the best fit to noise.
    problems.push(
      'The best V-slope split has CO₂ output rising more slowly above it, which is not a ventilatory threshold. VT1 not reported.',
    )
  } else {
    const sample = usable[keep[vSlope.index]]
    vt1 = {
      label: 'VT1',
      method: 'V-slope (Beaver)',
      t: sample.t,
      vo2: vSlope.x,
      heartRate: sample.heartRate ?? null,
      note: `Slope ${vSlope.slopeBefore.toFixed(2)} below, ${vSlope.slopeAfter.toFixed(2)} above.`,
    }
  }

  // --- VT2: ventilatory equivalent for CO₂ ---
  const equivalentIndices = keep.filter((i) => ve[i] != null && (vco2[i] as number) > 0)
  if (equivalentIndices.length < 30) {
    problems.push('No VE column was found, so VT2 cannot be computed.')
    return { vt1, vt2: null, problems }
  }

  const equivalent = equivalentIndices.map((i) => (ve[i] as number) / ((vco2[i] as number) / 1000))
  const times = equivalentIndices.map((i) => i)

  // The nadir of VE/VCO₂ is where respiratory compensation starts, so the
  // search runs from there rather than over the whole test: before the nadir
  // the ratio is falling, and a rise fitted across it is an artefact.
  let nadir = 0
  for (let i = 1; i < equivalent.length; i++) if (equivalent[i] < equivalent[nadir]) nadir = i
  const tail = equivalent.slice(nadir)
  const tailX = times.slice(nadir)

  const rise = twoSegmentBreakpoint(tailX, tail)
  let vt2: VentilatoryThreshold | null = null
  if (!rise) {
    problems.push('VE/VCO₂ has no clear rise after its minimum, so VT2 is not reported.')
  } else if (!(rise.slopeAfter > rise.slopeBefore)) {
    problems.push('VE/VCO₂ does not rise after its minimum, so VT2 is not reported.')
  } else {
    const sample = usable[keep[nadir + rise.index]]
    vt2 = {
      label: 'VT2',
      method: 'VE/VCO₂ rise (respiratory compensation)',
      t: sample?.t ?? 0,
      vo2: vo2[keep[nadir + rise.index]] ?? null,
      heartRate: sample?.heartRate ?? null,
      note: `VE/VCO₂ turns up from a minimum of ${equivalent[nadir].toFixed(1)}.`,
    }
  }

  if (vt1 && vt2 && vt2.t <= vt1.t) {
    problems.push(
      'VT2 was placed at or before VT1, which cannot be right. Treat both as unreliable for this test.',
    )
  }

  return { vt1, vt2, problems }
}

const countOf = (text: string, character: string): number =>
  text.split(character).length - 1
