import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { csvRows, parseAranetFile, parseAranetRows, readingsForSession } from './aranet'

const HEADER = [
  'Time(DD/MM/YYYY H:mm:ss)',
  'Carbon dioxide(ppm)',
  'Temperature(°C)',
  'Relative humidity(%)',
  'Atmospheric pressure(hPa)',
]

const local = (y: number, m: number, d: number, h: number, min: number, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime()

/** A worksheet the way the Aranet Home app writes one: every cell a string. */
function sheetXml(rows: string[][]): string {
  const letter = (i: number) => String.fromCharCode(65 + i)
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const body = rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">${cells
          .map((v, c) => `<c r="${letter(c)}${r + 1}" t="str"><v>${esc(v)}</v></c>`)
          .join('')}</row>`,
    )
    .join('')
  return `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`
}

/** The smallest zip that is still a zip, stored or deflated. */
function zip(files: Record<string, string>, deflate: boolean): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = encoder.encode(text)
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const nameBytes = encoder.encode(name)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true)
    head.setUint16(8, deflate ? 8 : 0, true)
    head.setUint32(18, data.length, true)
    head.setUint32(22, raw.length, true)
    head.setUint16(26, nameBytes.length, true)
    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(10, deflate ? 8 : 0, true)
    dir.setUint32(20, data.length, true)
    dir.setUint32(24, raw.length, true)
    dir.setUint16(28, nameBytes.length, true)
    dir.setUint32(42, offset, true)
    locals.push(new Uint8Array(head.buffer), nameBytes, data)
    central.push(new Uint8Array(dir.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const parts = [...locals, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const ROWS = [
  HEADER,
  ['03/04/2026 9:00:00', '497', '16,6', '69', '993,3'],
  ['03/04/2026 9:05:00', '474', '16,8', '68', '993,2'],
  ['03/04/2026 9:10:00', '486', '17,0', '67', '993,2'],
]

describe('the Aranet4 log', () => {
  it('reads the spreadsheet the app exports, stored or deflated', async () => {
    for (const deflate of [false, true]) {
      const file = zip({ 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': sheetXml(ROWS) }, deflate)
      const out = await parseAranetFile(file)
      expect(out.problems).toEqual([])
      expect(out.ignored).toEqual([])
      expect(out.intervalS).toBe(300)
      expect(out.readings).toHaveLength(3)
      expect(out.readings[0]).toEqual({
        at: local(2026, 4, 3, 9, 0),
        co2Ppm: 497,
        tempC: 16.6,
        humidityPct: 69,
        pressureHpa: 993.3,
      })
    }
  })

  it('takes the date order from the header and never from the numbers', () => {
    const american = [['Time(MM/DD/YYYY h:mm:ss A)', ...HEADER.slice(1)], ['03/04/2026 1:30:00 PM', '500', '70', '40', '1001']]
    expect(parseAranetRows(american).readings[0].at).toBe(local(2026, 3, 4, 13, 30))
    expect(parseAranetRows(ROWS).readings[0].at).toBe(local(2026, 4, 3, 9, 0))
  })

  it('leaves rows out rather than guessing when the header does not say', () => {
    const silent = [['Time', ...HEADER.slice(1)], ...ROWS.slice(1)]
    const out = parseAranetRows(silent)
    expect(out.readings).toHaveLength(0)
    expect(out.problems[0]).toMatch(/which way round/)
    // A year in front needs no header.
    const iso = [['Time', ...HEADER.slice(1)], ['2026-04-03 09:00:00', '497', '16.6', '69', '993.3']]
    expect(parseAranetRows(iso).readings[0].at).toBe(local(2026, 4, 3, 9, 0))
  })

  it('reads a CSV export with quoted decimal commas, and converts Fahrenheit', () => {
    const text =
      '﻿"Time(DD/MM/YYYY H:mm:ss)","Carbon dioxide(ppm)","Temperature(°F)","Relative humidity(%)","Battery"\r\n' +
      '"03/04/2026 9:00:00","497","69,8","40",""\r\n'
    const out = parseAranetRows(csvRows(text))
    expect(out.readings[0].tempC).toBeCloseTo(21, 1)
    expect(out.ignored).toEqual(['Battery'])
    const semicolons = csvRows('Time(DD.MM.YYYY H:mm:ss);Temperature(°C)\n03.04.2026 9:00:00;16,6\n')
    expect(parseAranetRows(semicolons).readings[0].tempC).toBe(16.6)
  })

  describe('onto a session', () => {
    const imported = parseAranetRows([
      HEADER,
      ...[-10, -5, 0, 5, 10, 15, 20, 25, 30].map((min) => {
        const at = new Date(local(2026, 4, 3, 9, 0) + min * 60000)
        const stamp = `${String(at.getDate()).padStart(2, '0')}/${String(at.getMonth() + 1).padStart(2, '0')}/${at.getFullYear()} ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}:00`
        return [stamp, '500', '21,0', '40', '1000']
      }),
    ])
    const session = {
      startedAt: local(2026, 4, 3, 9, 2),
      endedAt: local(2026, 4, 3, 9, 18),
      samples: [],
      environment: undefined,
    }

    it('keeps the session and one interval either side', () => {
      const picked = readingsForSession(imported, session, 'log.xlsx')
      expect(picked.add.map((r) => new Date(r.at).getMinutes())).toEqual([0, 5, 10, 15, 20])
      expect(picked.add[0]).toMatchObject({ source: 'import', tempC: 21, humidityPct: 40 })
      expect(picked.add[0].note).toMatch(/log\.xlsx/)
      expect(picked.add[0].setting).toBeUndefined()
      expect(picked.message).toMatch(/5 readings imported, one every 5 min/)
    })

    it('adds nothing the second time', () => {
      const first = readingsForSession(imported, session, 'log.xlsx')
      const second = readingsForSession(imported, { ...session, environment: first.add }, 'log.xlsx')
      expect(second.add).toHaveLength(0)
      expect(second.alreadyThere).toBe(5)
      expect(second.message).toMatch(/Nothing new/)
    })

    it('says what the file covers when it does not cover the session', () => {
      const later = { ...session, startedAt: local(2026, 9, 18, 2, 44), endedAt: local(2026, 9, 18, 4, 5) }
      const picked = readingsForSession(imported, later, 'log.xlsx')
      expect(picked.add).toHaveLength(0)
      expect(picked.message).toMatch(/Nothing imported: the file covers/)
    })
  })
})
