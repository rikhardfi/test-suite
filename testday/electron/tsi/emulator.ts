import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { preciseNow } from './timing'

export interface EmulatorOptions {
  /** Rows per stream command (the real meter: 30 s worth). */
  segmentRows: number
  /** Time between a stream ending and the next starting, ms (real: ~70–100). */
  restartDelayMs: number
  /** Rows are held and sent in bursts this far apart, ms, like the real link. */
  burstMs: number
  /** Constant flow, Std L/min. */
  flowLMin: number
  /**
   * Put each row's true sample time (wall clock, ms) in the low-pressure field,
   * so a test can check the client's timing against the truth.
   */
  encodeTime?: boolean
}

/**
 * A stand-in for a TSI 5330 on TCP, for tests. It keeps the behaviours the
 * client relies on and that were measured on the real meter: fixed-length
 * streams, commands queued during a stream, BREAK cancelling both, a restart
 * cost between streams, bursty delivery, and a totalizer that keeps counting
 * while nothing is being sent.
 */
export class TsiEmulator {
  readonly received: string[] = []
  private readonly opts: EmulatorOptions
  private server: Server | null = null
  private client: Socket | null = null
  private rateMs = 10
  private streaming = false
  private streamStart = 0
  private sent = 0
  private queue: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private restart: ReturnType<typeof setTimeout> | null = null
  private totalizerZeroAt = preciseNow()
  private inbox = ''

  constructor(options: EmulatorOptions) {
    this.opts = options
  }

  async listen(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    this.halt()
    this.client?.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  /** Drops the connection, as a pulled cable would. */
  dropConnection(): void {
    this.client?.destroy()
  }

  private accept(socket: Socket): void {
    this.client?.destroy()
    this.client = socket
    socket.setNoDelay(true)
    socket.setEncoding('ascii')
    socket.on('data', (chunk: string) => {
      this.inbox += chunk
      let at: number
      while ((at = this.inbox.indexOf('\r')) >= 0) {
        const command = this.inbox.slice(0, at).trim()
        this.inbox = this.inbox.slice(at + 1)
        if (command) this.onCommand(command)
      }
    })
    socket.on('error', () => {})
  }

  private write(text: string): void {
    if (this.client && !this.client.destroyed) this.client.write(text)
  }

  private totalAt(t: number): number {
    return (this.opts.flowLMin * (t - this.totalizerZeroAt)) / 60_000
  }

  private onCommand(command: string): void {
    this.received.push(command)
    if (command === 'BREAK') {
      this.halt()
      this.queue = []
      this.write('OK\r\n')
      return
    }
    if (this.streaming || this.restart) {
      this.queue.push(command)
      return
    }
    this.execute(command)
  }

  private execute(command: string): void {
    const values: Record<string, string> = {
      MN: '533002',
      SN: 'EMULATOR01',
      REV: '1.0.4-emulator',
      DATE: '2026-04-27T00:00:00Z',
      RSR: String(this.rateMs),
      RU: 'S',
      RCH: '1',
      RCD: '0',
    }
    if (command in values) {
      this.write(`OK\r\n${values[command]}\r\n`)
    } else if (/^SSR\d{4}$/.test(command)) {
      this.rateMs = Number(command.slice(3))
      this.write('OK\r\n')
    } else if (command === 'LPZ' || command === '?') {
      this.write('OK\r\n')
    } else if (command === 'TRESET') {
      this.totalizerZeroAt = preciseNow()
      this.write('OK\r\n')
    } else if (command === 'DCFTPHLI0000') {
      this.write('OK\r\n')
      this.restart = setTimeout(() => {
        this.restart = null
        this.beginStream()
      }, this.opts.restartDelayMs)
    } else {
      this.write('ERR1\r\n')
    }
  }

  private beginStream(): void {
    this.streaming = true
    this.streamStart = preciseNow()
    this.sent = 0
    this.timer = setInterval(() => this.pump(), this.opts.burstMs)
  }

  /** Sends every row whose sample time has passed, as one burst. */
  private pump(): void {
    const now = preciseNow()
    let text = ''
    while (this.sent < this.opts.segmentRows) {
      const t = this.streamStart + (this.sent + 1) * this.rateMs
      if (t > now) break
      const lp = this.opts.encodeTime ? t.toFixed(3) : '-0.13'
      text += `${this.opts.flowLMin.toFixed(2)},30.00,98.58,90.0,${lp},${this.totalAt(t).toFixed(4)}\r\n`
      this.sent += 1
    }
    if (text) this.write(text)
    if (this.sent >= this.opts.segmentRows) {
      this.halt()
      const next = this.queue.shift()
      if (next) this.execute(next)
      while (this.queue.length && !this.restart) this.execute(this.queue.shift()!)
    }
  }

  private halt(): void {
    this.streaming = false
    if (this.timer) clearInterval(this.timer)
    if (this.restart) clearTimeout(this.restart)
    this.timer = null
    this.restart = null
  }
}
