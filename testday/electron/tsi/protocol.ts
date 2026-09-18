import type { NetworkInterfaceInfo } from 'node:os'

/**
 * The TSI 5300-series ASCII command set (TSI P/N 6011697), as far as this app
 * uses it, and the parts of the meter's behaviour the manual does not state
 * but the recorder depends on. Everything below was measured on a 5330
 * (firmware 1.0.4) over its USB network link.
 *
 * - The meter's USB-C port is a network adapter. The Mac gets a link-local
 *   address on a /30 and the meter takes one of the other two; it listens on
 *   TCP 3607. No driver and no TSI software are involved.
 * - Commands end in CR. Replies are `OK` or `ERRn`, then any value, each CRLF.
 * - `DCFTPHLI0000` streams exactly 30 s of rows, then stops.
 * - A command sent during a stream is queued and runs when the stream ends.
 *   Its `OK` therefore marks the boundary between two streams. One sent at the
 *   instant a stream ends can be lost, so the next stream is queued early.
 * - A stream outlives the connection that asked for it and is delivered to
 *   the next one, so every connection starts with `BREAK`.
 */

export const TSI_PORT = 3607

/** How long one continuous-stream command runs on the meter. */
export const SEGMENT_MS = 30_000

export const RATES_MS = [1, 2, 5, 10, 20, 50, 100] as const

const pad4 = (n: number) => String(Math.round(n)).padStart(4, '0')

export const cmd = {
  ping: '?',
  stop: 'BREAK',
  model: 'MN',
  serial: 'SN',
  firmware: 'REV',
  calibrationDate: 'DATE',
  readRate: 'RSR',
  readUnits: 'RU',
  readHumidityComp: 'RCH',
  readDirection: 'RCD',
  zeroLowPressure: 'LPZ',
  resetTotalizer: 'TRESET',
  setRate: (ms: number) => `SSR${pad4(ms)}`,
  /** Flow, temperature, pressure, humidity, low pressure, totalizer, 30 s. */
  stream: 'DCFTPHLI0000',
} as const

/** One row of the six-channel stream, in the meter's units. */
export interface TsiRow {
  /** Std L/min (humidity-compensated, dry-gas equivalent). */
  flow: number
  /** °C, gas in the flow tube. */
  tempC: number
  /** kPa absolute. */
  pressureKpa: number
  /** %RH at the sensor near the inlet. */
  humidityPct: number
  /** cmH2O. */
  lowPressureCmH2O: number
  /** L since power-on or the last TRESET. */
  totalL: number
}

export type TsiLine =
  | { kind: 'row'; row: TsiRow }
  | { kind: 'ok' }
  | { kind: 'error'; code: number }
  | { kind: 'text'; text: string }

export function parseLine(line: string): TsiLine {
  const text = line.trim()
  if (text === 'OK') return { kind: 'ok' }
  const err = /^ERR(\d+)$/i.exec(text)
  if (err) return { kind: 'error', code: Number(err[1]) }
  const parts = text.split(',')
  // `Number('')` is 0, so an empty field has to be refused before conversion.
  if (parts.length === 6 && parts.every((part) => part.trim() !== '')) {
    const v = parts.map(Number)
    if (v.every(Number.isFinite)) {
      return {
        kind: 'row',
        row: {
          flow: v[0],
          tempC: v[1],
          pressureKpa: v[2],
          humidityPct: v[3],
          lowPressureCmH2O: v[4],
          totalL: v[5],
        },
      }
    }
  }
  return { kind: 'text', text }
}

/** Splits a byte stream into complete lines, keeping the unfinished tail. */
export class LineSplitter {
  private tail = ''

  push(chunk: string): string[] {
    const text = this.tail + chunk
    const lines = text.split('\n')
    this.tail = lines.pop() ?? ''
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
  }

  reset(): void {
    this.tail = ''
  }
}

/**
 * Addresses the meter could have: the other usable hosts on every link-local
 * /30 this computer holds. Probed in order; the first that accepts port 3607
 * is the meter.
 */
export function meterCandidates(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
): string[] {
  const out: string[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.netmask !== '255.255.255.252') continue
      const octets = info.address.split('.').map(Number)
      if (octets[0] !== 169 || octets[1] !== 254) continue
      const base = octets[3] & ~3
      for (const host of [base + 1, base + 2]) {
        if (host !== octets[3]) out.push(`169.254.${octets[2]}.${host}`)
      }
    }
  }
  return out
}
