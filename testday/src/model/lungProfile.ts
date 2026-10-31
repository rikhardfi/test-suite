import { gliFrcL, type Sex } from './karamaoun'

/**
 * What the airway model needs to know about an athlete's lungs and breathing,
 * and the two imports that fill it in.
 *
 * - A Medikro Pro spirometry export (SpiroXML2): height, sex, birth date and
 *   the best pre-bronchodilator FVC and FEV₁. The same fields `parse_medikro.py`
 *   in medikro-xml reads. Nothing else in the file is kept; names and personal
 *   IDs never leave the parser.
 * - A ventilation-project athlete config (`config/athletes/<ID>.yml`): the
 *   newest dated HR–VE curve, to predict VE from heart rate.
 *
 * Pure.
 */

export interface LungProfile {
  heightCm: number
  sex: Sex
  /** YYYY-MM-DD, for the age the FRC is predicted at. */
  birthDate?: string
  /** Age at the spirometry, years; used when there is no birth date. */
  ageAtTestY?: number
  /** YYYY-MM-DD */
  spirometryDate?: string
  fvcL?: number
  fev1L?: number
  /** Overrides the GLI prediction when a measured FRC exists. */
  measuredFrcL?: number
}

export interface HrVeCurve {
  /** e.g. "treadmill 2023-08-14" */
  label: string
  points: { hr: number; ve: number }[]
}

/** FRC in litres on the given day, and how it was obtained. Null without a profile. */
export function frcOf(lungs: LungProfile | undefined, on: Date = new Date()): { frcL: number; source: string } | null {
  if (!lungs) return null
  if (lungs.measuredFrcL) return { frcL: lungs.measuredFrcL, source: 'measured' }
  const age = ageOn(lungs, on)
  if (age == null) return null
  const frcL = gliFrcL(lungs.sex, age, lungs.heightCm)
  return Number.isFinite(frcL) ? { frcL, source: `GLI 2021 predicted, age ${age.toFixed(1)}` } : null
}

function ageOn(lungs: LungProfile, on: Date): number | null {
  const years = (from: string) => (on.getTime() - new Date(from).getTime()) / (365.2425 * 86400e3)
  if (lungs.birthDate) return years(lungs.birthDate)
  if (lungs.ageAtTestY != null && lungs.spirometryDate) return lungs.ageAtTestY + years(lungs.spirometryDate)
  return lungs.ageAtTestY ?? null
}

// --- Medikro SpiroXML2 -----------------------------------------------------------

type Row = Record<string, string>

/**
 * Every row of the file as a dict of its own C children, depth-first, with
 * the name of the table it sits in. The format is a tree of `<E T=".." N=".."
 * V="..">`: D document, T table, R row, C cell.
 */
function rows(xml: string): { table: string; cols: Row }[] {
  const out: { table: string; cols: Row }[] = []
  const stack: { T: string; N: string; cols?: Row }[] = []
  const tag = /<(\/?)E\b([^>]*?)(\/?)>/g
  const attr = (s: string, name: string) => s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const [, closing, attrs, selfClosing] = m
    if (closing) {
      const done = stack.pop()
      if (done?.T === 'R' && done.cols) {
        const table = [...stack].reverse().find((e) => e.T === 'T')?.N ?? ''
        out.push({ table, cols: done.cols })
      }
      continue
    }
    const T = attr(attrs, 'T')
    const N = attr(attrs, 'N')
    if (T === 'C') {
      const row = [...stack].reverse().find((e) => e.T === 'R')
      if (row && !(N in row.cols!)) row.cols![N] = attr(attrs, 'V')
      if (!selfClosing) stack.push({ T, N })
      continue
    }
    if (!selfClosing) stack.push({ T, N, cols: T === 'R' ? {} : undefined })
  }
  return out
}

/** The first session of a Medikro export. Throws with a sentence when it is not one. */
export function lungsFromMedikro(xml: string): LungProfile {
  if (!xml.includes('SpiroXML2')) throw new Error('This is not a Medikro SpiroXML2 export.')
  const all = rows(xml)
  const person = all.find((r) => r.table === 'Person')?.cols
  const session = all.find((r) => r.table === 'Data' && 'Height' in r.cols && 'Age' in r.cols)?.cols
  if (!person || !session) throw new Error('The export has no person or session data.')
  const best = all.find(
    (r) => r.table === 'Data' && 'Ref_FEVC' in r.cols && !(r.cols.Phase ?? '').startsWith('Post'),
  )?.cols
  const heightCm = Number(session.Height)
  const sex = Number(person.Gender ?? session.Gender)
  if (!(heightCm > 50) || (sex !== 1 && sex !== 2)) throw new Error('The export has no usable height or sex.')
  const date = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined)
  const num = (s?: string) => (s != null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined)
  return {
    heightCm,
    sex: sex as Sex,
    birthDate: date(person.BirthDate),
    ageAtTestY: num(session.Age),
    spirometryDate: date(session.SessionTime),
    fvcL: num(best?.FEVC),
    fev1L: num(best?.FEV1),
  }
}

// --- ventilation-project athlete config ---------------------------------------------

/**
 * The newest dated HR–VE curve in an athlete YAML. Reads only the shape that
 * file has (a list of periods with `valid_from`, `modality` and `points` of
 * `heart_rate` / `ve`), so the app needs no YAML library.
 */
export function hrVeFromAthleteYaml(yaml: string): HrVeCurve {
  const periods: { from: string; modality: string; points: { hr: number; ve: number }[] }[] = []
  let current: (typeof periods)[number] | null = null
  let hr: number | null = null
  for (const line of yaml.split(/\r?\n/)) {
    const start = line.match(/^-\s+valid_from:\s*'?([\d-]+)'?/)
    if (start) {
      current = { from: start[1], modality: '', points: [] }
      periods.push(current)
      continue
    }
    if (/^\S/.test(line)) current = null
    if (!current) continue
    const mod = line.match(/^\s+modality:\s*(\S+)/)
    if (mod) current.modality = mod[1]
    const h = line.match(/^\s+-\s+heart_rate:\s*([\d.]+)/)
    if (h) hr = Number(h[1])
    const v = line.match(/^\s+ve:\s*([\d.]+)/)
    if (v && hr != null) {
      current.points.push({ hr, ve: Number(v[1]) })
      hr = null
    }
  }
  const newest = periods.filter((p) => p.points.length >= 2).sort((a, b) => a.from.localeCompare(b.from)).pop()
  if (!newest) throw new Error('No dated HR–VE curve with points was found in this file.')
  return {
    label: `${newest.modality.replace(/_/g, ' ') || 'curve'} ${newest.from}`,
    points: newest.points.sort((a, b) => a.hr - b.hr),
  }
}

/** VE from heart rate on the curve, linear, held at the ends. */
export function veFromHr(curve: HrVeCurve | undefined, heartRate: number | null | undefined): number | null {
  if (!curve || heartRate == null || !Number.isFinite(heartRate)) return null
  const p = curve.points
  if (heartRate <= p[0].hr) return p[0].ve
  if (heartRate >= p[p.length - 1].hr) return p[p.length - 1].ve
  let i = 1
  while (p[i].hr < heartRate) i++
  return p[i - 1].ve + ((heartRate - p[i - 1].hr) * (p[i].ve - p[i - 1].ve)) / (p[i].hr - p[i - 1].hr)
}
