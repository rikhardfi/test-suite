import type { MetricUpdate } from './types'

/**
 * Raw notification bytes, captured and replayable.
 *
 * The parsers are tested against synthetic packets, which is worth something
 * and is not the same as being tested against reality. Real trainers break the
 * specification in ways nobody thinks to write a synthetic test for: fields
 * present that the flags say are absent, counters that wrap early, a "more
 * data" bit inverted. The only way to find those is to keep what the device
 * actually sent.
 *
 * It is also the only route to a device with no published profile. A parser for
 * one of those cannot be written from a specification, because there is not
 * one; it has to be reversed from a capture taken while the device was doing
 * something known.
 *
 * Bytes are stored as hex rather than base64: a trace gets read by eye at least
 * once, and hex is what a protocol is discussed in.
 */

export interface TraceEntry {
  /** Milliseconds since the capture started. */
  t: number
  deviceId: string
  deviceName: string
  /** Characteristic the notification arrived on. */
  characteristic: string
  /** Lowercase hex, no separators. */
  hex: string
  /** What the parser made of it at capture time, for comparison on replay. */
  decoded?: MetricUpdate
}

export interface Trace {
  format: 'testday-ble-trace'
  version: 1
  startedAt: string
  /** Free text: which device, which firmware, what the athlete was doing. */
  note?: string
  entries: TraceEntry[]
}

export const toHex = (view: DataView): string => {
  let out = ''
  for (let i = 0; i < view.byteLength; i++) {
    out += view.getUint8(i).toString(16).padStart(2, '0')
  }
  return out
}

export function fromHex(hex: string): DataView {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return new DataView(bytes.buffer)
}

/**
 * Collects notifications while it is running.
 *
 * Bounded, because a capture left on for a whole test day would otherwise grow
 * without limit in a process that is also recording a session. It keeps the
 * most recent entries, since a capture is normally stopped just after the
 * interesting thing happened.
 */
export class TraceRecorder {
  private entries: TraceEntry[] = []
  private startedAt = 0
  private running = false

  constructor(private readonly limit = 20000) {}

  get isRecording(): boolean {
    return this.running
  }

  get size(): number {
    return this.entries.length
  }

  start(now = Date.now()): void {
    this.entries = []
    this.startedAt = now
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  capture(
    deviceId: string,
    deviceName: string,
    characteristic: string,
    view: DataView,
    decoded?: MetricUpdate,
    now = Date.now(),
  ): void {
    if (!this.running) return
    this.entries.push({
      t: now - this.startedAt,
      deviceId,
      deviceName,
      characteristic,
      hex: toHex(view),
      decoded,
    })
    if (this.entries.length > this.limit) this.entries.shift()
  }

  toTrace(note?: string): Trace {
    return {
      format: 'testday-ble-trace',
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      note,
      entries: [...this.entries],
    }
  }
}

export interface ReplayDisagreement {
  index: number
  characteristic: string
  hex: string
  captured: MetricUpdate
  replayed: MetricUpdate | { error: string }
}

/**
 * Feeds a trace back through a parser and reports where it now disagrees with
 * what was recorded at capture time.
 *
 * This is the regression check the synthetic tests cannot be: change a parser,
 * replay every trace ever captured from real hardware, and see exactly which
 * real packets the change affects.
 */
export function replay(
  trace: Trace,
  parserFor: (characteristic: string) => ((view: DataView) => MetricUpdate) | null,
): ReplayDisagreement[] {
  const out: ReplayDisagreement[] = []

  trace.entries.forEach((entry, index) => {
    if (!entry.decoded) return
    const parse = parserFor(entry.characteristic)
    if (!parse) return

    let replayed: MetricUpdate | { error: string }
    try {
      replayed = parse(fromHex(entry.hex))
    } catch (error) {
      replayed = { error: error instanceof Error ? error.message : String(error) }
    }

    if (!sameUpdate(entry.decoded, replayed as MetricUpdate)) {
      out.push({
        index,
        characteristic: entry.characteristic,
        hex: entry.hex,
        captured: entry.decoded,
        replayed,
      })
    }
  })

  return out
}

/** Numeric comparison with a tolerance, since parsers scale and round. */
function sameUpdate(a: MetricUpdate, b: MetricUpdate): boolean {
  if (!b || typeof b !== 'object' || 'error' in b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const left = (a as Record<string, unknown>)[key]
    const right = (b as Record<string, unknown>)[key]
    if (Array.isArray(left) || Array.isArray(right)) {
      if (JSON.stringify(left) !== JSON.stringify(right)) return false
      continue
    }
    if (typeof left === 'number' && typeof right === 'number') {
      if (Math.abs(left - right) > 1e-6) return false
      continue
    }
    if (left !== right) return false
  }
  return true
}
