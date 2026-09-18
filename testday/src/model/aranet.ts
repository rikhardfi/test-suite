import type { Environment, SessionRecord } from './session'

/**
 * Room conditions from an Aranet4's own log, brought in after the test.
 *
 * The monitor logs to its own memory whether or not anything is connected to
 * it, so this route needs nothing to work on the day: no pairing, no Bluetooth
 * link to hold, nothing on the test-day machine that can fail. The Aranet Home
 * app exports the log as a spreadsheet or a CSV, and both carry the same table:
 *
 *   Time(DD/MM/YYYY H:mm:ss) | Carbon dioxide(ppm) | Temperature(°C) |
 *   Relative humidity(%) | Atmospheric pressure(hPa)
 *
 * with every cell as text, decimal commas where the phone's language uses
 * them, and the date format written into the header. That last part is what
 * makes the file safe to read: 03/04 is never guessed at.
 *
 * The times are the phone's local clock with no zone. They are read in this
 * computer's zone, which is right whenever the test and the import happen in
 * the same country, and the imported record says that this is what was done.
 */

export interface AranetReading {
  at: number
  tempC?: number
  humidityPct?: number
  co2Ppm?: number
  pressureHpa?: number
}

type ValueKey = Exclude<keyof AranetReading, 'at'>

export interface AranetImport {
  readings: AranetReading[]
  /** Headers that were understood, so the operator can see what was read. */
  matched: Partial<Record<'time' | ValueKey, string>>
  /** Headers that were not, so a missing column is visible rather than silent. */
  ignored: string[]
  /** The logger's interval in seconds, from the rows themselves. */
  intervalS: number | null
  /** Why nothing, or less than everything, was read. Empty when all is well. */
  problems: string[]
}

const COLUMN_ALIASES: Record<'time' | ValueKey, string[]> = {
  time: ['time', 'aika', 'date', 'datetime', 'timestamp'],
  co2Ppm: ['carbondioxide', 'co2', 'hiilidioksidi'],
  tempC: ['temperature', 'lampotila', 'temp'],
  humidityPct: ['relativehumidity', 'humidity', 'suhteellinenkosteus', 'kosteus', 'rh'],
  pressureHpa: ['atmosphericpressure', 'pressure', 'ilmanpaine'],
}

const normalise = (header: string): string =>
  header
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]/g, '')

const unitOf = (header: string): string => /\((.*)\)/.exec(header)?.[1]?.trim() ?? ''

// --- the table ----------------------------------------------------------------

export function parseAranetRows(rows: readonly (readonly string[])[]): AranetImport {
  const empty: AranetImport = { readings: [], matched: {}, ignored: [], intervalS: null, problems: [] }
  if (rows.length < 2) return { ...empty, problems: ['The file has no rows under its header.'] }

  const headers = rows[0].map((h) => h.trim())
  const matched: AranetImport['matched'] = {}
  const columnFor: Partial<Record<'time' | ValueKey, number>> = {}
  const used = new Set<number>()
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES) as ['time' | ValueKey, string[]][]) {
    const index = headers.findIndex((h, i) => !used.has(i) && aliases.includes(normalise(h)))
    if (index === -1) continue
    columnFor[key] = index
    matched[key] = headers[index]
    used.add(index)
  }
  const ignored = headers.filter((h, i) => h && !used.has(i))
  const problems: string[] = []

  if (columnFor.time == null) {
    return { ...empty, ignored, problems: ['No time column was found, so no row can be placed.'] }
  }
  const order = dateOrder(unitOf(headers[columnFor.time]))
  const fahrenheit = columnFor.tempC != null && /f/i.test(unitOf(headers[columnFor.tempC]))

  const readings: AranetReading[] = []
  let unreadable = 0
  for (const cells of rows.slice(1)) {
    const at = parseLocalTime(cells[columnFor.time] ?? '', order)
    if (at == null) {
      if ((cells[columnFor.time] ?? '').trim()) unreadable += 1
      continue
    }
    const value = (key: ValueKey): number | undefined => {
      const index = columnFor[key]
      if (index == null) return undefined
      const raw = (cells[index] ?? '').trim().replace(',', '.')
      if (!raw) return undefined
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    const temp = value('tempC')
    readings.push({
      at,
      tempC: temp != null && fahrenheit ? Number((((temp - 32) * 5) / 9).toFixed(2)) : temp,
      humidityPct: value('humidityPct'),
      co2Ppm: value('co2Ppm'),
      pressureHpa: value('pressureHpa'),
    })
  }
  readings.sort((a, b) => a.at - b.at)

  if (unreadable > 0) {
    problems.push(
      order
        ? `${unreadable} rows had a time that could not be read.`
        : `The time column does not say which way round its dates are (expected something like "Time(DD/MM/YYYY H:mm:ss)"), and ${unreadable} rows were left out rather than guessed at.`,
    )
  }
  return { readings, matched, ignored, intervalS: medianInterval(readings), problems }
}

/** Which of day, month and year comes first, second and third. */
type DateOrder = readonly ['d' | 'm' | 'y', 'd' | 'm' | 'y', 'd' | 'm' | 'y']

/**
 * Read from the format in the header, e.g. "DD/MM/YYYY H:mm:ss". Only the date
 * half is looked at, since "mm" further along means minutes.
 */
function dateOrder(format: string): DateOrder | null {
  const datePart = format.trim().split(/[\sT]/)[0].toLowerCase()
  const positions = (['d', 'm', 'y'] as const)
    .map((token) => ({ token, index: datePart.indexOf(token) }))
    .filter((p) => p.index >= 0)
    .sort((a, b) => a.index - b.index)
  if (positions.length !== 3) return null
  return positions.map((p) => p.token) as unknown as DateOrder
}

function parseLocalTime(raw: string, order: DateOrder | null): number | null {
  const numbers = raw.match(/\d+/g)?.map(Number)
  if (!numbers || numbers.length < 5) return null
  // A four-digit year in front is unambiguous whatever the header says.
  const effective: DateOrder | null = /^\s*\d{4}\D/.test(raw) ? ['y', 'm', 'd'] : order
  if (!effective) return null

  const part = { d: 0, m: 0, y: 0 }
  effective.forEach((token, i) => (part[token] = numbers[i]))
  let hour = numbers[3]
  const [minute, second = 0] = numbers.slice(4)
  if (/pm/i.test(raw) && hour < 12) hour += 12
  if (/am/i.test(raw) && hour === 12) hour = 0
  if (part.y < 100) part.y += 2000
  if (part.m < 1 || part.m > 12 || part.d < 1 || part.d > 31 || hour > 23 || minute > 59) return null

  const at = new Date(part.y, part.m - 1, part.d, hour, minute, second).getTime()
  return Number.isFinite(at) ? at : null
}

function medianInterval(readings: readonly AranetReading[]): number | null {
  if (readings.length < 2) return null
  const gaps = readings
    .slice(1)
    .map((r, i) => (r.at - readings[i].at) / 1000)
    .filter((g) => g > 0)
    .sort((a, b) => a - b)
  return gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null
}

// --- the two containers ---------------------------------------------------------

/** A CSV export: comma or semicolon, quoted or not. */
export function csvRows(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (!lines.length) return []
  const count = (char: string) => lines[0].split(char).length - 1
  const delimiter = count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ','
  return lines.map((line) => splitQuoted(line, delimiter))
}

/** Splits on the delimiter outside quotes, so "21,4" survives a comma file. */
function splitQuoted(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"'
        i += 1
      } else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      cells.push(cell)
      cell = ''
    } else cell += char
  }
  cells.push(cell)
  return cells
}

/**
 * The first worksheet of an .xlsx as rows of text.
 *
 * An .xlsx is a zip of XML, and this reads exactly as much of both as the job
 * needs: the zip's directory, one worksheet, and the shared strings if the
 * sheet uses them. That is a page of code against a dependency that would be
 * the largest thing in the application, in an application whose rule is that
 * nothing it cannot account for runs on a test day.
 */
export async function readXlsxSheet(bytes: Uint8Array): Promise<string[][]> {
  const files = zipDirectory(bytes)
  const sheetName = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]
  if (!sheetName) throw new Error('This is not a spreadsheet the importer can read: it has no worksheet.')

  const decode = async (name: string) => new TextDecoder().decode(await unzip(bytes, files.get(name) as ZipEntry))
  const shared = files.has('xl/sharedStrings.xml')
    ? [...(await decode('xl/sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : []

  const rows: string[][] = []
  for (const row of (await decode(sheetName)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cell[1])?.[1]
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1]
      const body = cell[2] ?? ''
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
      const value = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? textOf(body) : unescapeXml(raw)
      cells[ref ? columnIndex(ref) : cells.length] = value
    }
    rows.push(Array.from(cells, (c) => c ?? ''))
  }
  return rows
}

const columnIndex = (letters: string): number =>
  [...letters].reduce((n, char) => n * 26 + (char.charCodeAt(0) - 64), 0) - 1

const textOf = (xml: string): string =>
  [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('')

const unescapeXml = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

interface ZipEntry {
  method: number
  compressedSize: number
  localOffset: number
}

function zipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('This is not a spreadsheet the importer can read: it is not a zip file.')

  const files = new Map<string, ZipEntry>()
  let offset = view.getUint32(end + 16, true)
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const nameLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    files.set(name, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localOffset: view.getUint32(offset + 42, true),
    })
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  return files
}

async function unzip(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start =
    entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new Error(`The spreadsheet uses a compression method (${entry.method}) the importer does not read.`)
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Either container, told apart by what the file is rather than what it is called. */
export async function parseAranetFile(bytes: Uint8Array): Promise<AranetImport> {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const rows = isZip ? await readXlsxSheet(bytes) : csvRows(new TextDecoder().decode(bytes))
  return parseAranetRows(rows)
}

// --- onto a session -----------------------------------------------------------

export interface AranetSelection {
  /** Readings to append, as the session's own record type. */
  add: Environment[]
  /** In the session's window but already in the record from an earlier import. */
  alreadyThere: number
  /** What happened, in a sentence the operator can act on. */
  message: string
}

/**
 * The part of a log that belongs to one session.
 *
 * One logging interval either side is kept as well. A monitor on a five minute
 * interval gives a twenty minute test four readings, and the ones just before
 * and just after are what say whether the room was steady through it.
 */
export function readingsForSession(
  imported: AranetImport,
  session: Pick<SessionRecord, 'startedAt' | 'endedAt' | 'samples' | 'environment'>,
  fileName: string,
): AranetSelection {
  const { readings } = imported
  if (!readings.length) return { add: [], alreadyThere: 0, message: imported.problems[0] ?? 'The file has no readings in it.' }

  const lastT = session.samples.length ? session.samples[session.samples.length - 1].t : 0
  const endedAt = session.endedAt ?? session.startedAt + lastT * 1000
  const marginMs = (imported.intervalS ?? 0) * 1000
  const inWindow = readings.filter((r) => r.at >= session.startedAt - marginMs && r.at <= endedAt + marginMs)

  const day = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  if (!inWindow.length) {
    return {
      add: [],
      alreadyThere: 0,
      message: `Nothing imported: the file covers ${day(readings[0].at)} to ${day(readings[readings.length - 1].at)}, and this session started ${day(session.startedAt)}.`,
    }
  }

  const existing = new Set((session.environment ?? []).filter((e) => e.source === 'import').map((e) => e.at))
  const fresh = inWindow.filter((r) => !existing.has(r.at))
  const note = `Aranet4 log, ${fileName}. Times are the monitor's local clock, read in this computer's time zone.`
  const add = fresh.map((r) => ({ ...r, note, source: 'import' as const }))

  const interval = imported.intervalS ? `, one every ${Math.round(imported.intervalS / 60) || 1} min` : ''
  const message = !fresh.length
    ? `Nothing new: all ${inWindow.length} readings for this session were imported earlier.`
    : `${fresh.length} readings imported${interval}.${inWindow.length - fresh.length ? ` ${inWindow.length - fresh.length} were already there.` : ''}`
  return { add, alreadyThere: inWindow.length - fresh.length, message }
}
