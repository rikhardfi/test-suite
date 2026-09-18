import { Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type {
  FlowBlock,
  FlowCommand,
  FlowCommandKind,
  FlowMeterRecord,
  FlowMeterState,
  FlowMeterStatus,
  FlowSegment,
  SegmentStart,
} from '../../src/model/flow'
import { LineSplitter, SEGMENT_MS, TSI_PORT, cmd, meterCandidates, parseLine, type TsiRow } from './protocol'
import { SegmentClock, gapSamples, gapVolumeL, preciseNow } from './timing'

export interface TsiMeterOptions {
  /** Meter address; discovered on the USB link when omitted. */
  host?: string
  port?: number
  rateMs: number
  /** Length of one stream command. Only tests change it. */
  segmentMs?: number
  /** How often buffered rows are handed on as a block. */
  flushMs?: number
  reconnectMs?: number
  now?: () => number
  candidates?: () => string[]
  onBlock?: (block: FlowBlock) => void
  onSegment?: (segment: FlowSegment) => void
  onMeter?: (meter: FlowMeterRecord) => void
  onCommand?: (command: FlowCommand) => void
  onState?: (state: FlowMeterState, error: string | null) => void
}

/** Silence that means a stop has taken effect and nothing more is in flight. */
const DRAIN_QUIET_MS = 300
const DRAIN_RETRY_MS = 2000
const REPLY_TIMEOUT_MS = 2000
/** Queue the next stream this long before the current one ends. */
const QUEUE_AHEAD_MS = 500

type Mode = 'idle' | 'drain' | 'command' | 'stream'

interface OpenSegment {
  seg: number
  clock: SegmentClock
  start: SegmentStart
  /** Rows not yet handed on. */
  pending: Omit<FlowBlock, 'type' | 'seg' | 'at0' | 'dt'>
  firstRow: TsiRow | null
  lastRow: TsiRow | null
  queued: boolean
}

interface Waiter {
  resolve: (line: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One TSI 5300-series meter over its USB network link.
 *
 * Streams continuously for as long as it runs, chaining 30 s stream commands
 * with the next one queued before the current one ends, and reconnects on its
 * own if the link drops. Rows are timed from their index (see `timing.ts`) and
 * handed on in blocks; each segment is closed with a record carrying its final
 * timing and what was lost since the previous one. Nothing here knows about
 * sessions: the caller decides what to keep.
 */
export class TsiMeter {
  private readonly opts: Required<Omit<TsiMeterOptions, 'host' | 'onBlock' | 'onSegment' | 'onMeter' | 'onCommand' | 'onState'>> &
    TsiMeterOptions
  private socket: Socket | null = null
  private readonly splitter = new LineSplitter()
  private mode: Mode = 'idle'
  private waiters: Waiter[] = []
  private lines: string[] = []
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private drainDone: (() => void) | null = null
  private drainStartedAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private busy: Promise<void> = Promise.resolve()
  private lastDataAt = 0

  private segment: OpenSegment | null = null
  private nextSeg = 0
  private nextStart: SegmentStart = 'first'
  private previous: { endMs: number; lastRow: TsiRow; dt: number } | null = null
  private totalizerResetSincePrevious = false

  private _state: FlowMeterState = 'disconnected'
  private _host: string | null = null
  private _meter: FlowMeterRecord | null = null
  private error: string | null = null
  private rows = 0
  private gaps = 0
  private lastGapMs: number | null = null
  private latest: TsiRow | null = null
  private flowSum = 0
  private flowCount = 0

  constructor(options: TsiMeterOptions) {
    this.opts = {
      port: TSI_PORT,
      segmentMs: SEGMENT_MS,
      flushMs: 1000,
      reconnectMs: 2000,
      now: preciseNow,
      candidates: () => meterCandidates(networkInterfaces()),
      ...options,
    }
  }

  get state(): FlowMeterState {
    return this._state
  }

  get meter(): FlowMeterRecord | null {
    return this._meter
  }

  get rateMs(): number {
    return this.opts.rateMs
  }

  /** Connects and streams until `stop`. Resolves once the first stream has started. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.nextStart = 'first'
    this.previous = null
    await this.connectAndStream('connecting')
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    await this.exclusive(async () => {
      if (this.socket && this.mode === 'stream') {
        this.closeSegment()
        await this.stopStream()
      }
    })
    this.teardown()
    this.setState('disconnected', null)
  }

  zeroLowPressure(): Promise<FlowCommand> {
    return this.command('zeroLowPressure', [cmd.zeroLowPressure])
  }

  resetTotalizer(): Promise<FlowCommand> {
    return this.command('resetTotalizer', [cmd.resetTotalizer], () => {
      this.totalizerResetSincePrevious = true
    })
  }

  setRate(ms: number): Promise<FlowCommand> {
    return this.command('rate', [cmd.setRate(ms)], () => {
      this.opts.rateMs = ms
      if (this._meter) this._meter = { ...this._meter, rateMs: ms }
    }, `${ms} ms`)
  }

  /** Current values, with mean flow since the previous call. */
  status(): FlowMeterStatus {
    const row = this.latest
    const mean = this.flowCount ? this.flowSum / this.flowCount : row?.flow ?? null
    this.flowSum = 0
    this.flowCount = 0
    const meter = this._meter
      ? (({ type: _t, at: _a, ...rest }) => rest)(this._meter)
      : null
    return {
      state: this._state,
      host: this._host,
      meter,
      rateMs: this.opts.rateMs,
      flowLMin: row ? mean : null,
      tempC: row?.tempC ?? null,
      humidityPct: row?.humidityPct ?? null,
      pressureKpa: row?.pressureKpa ?? null,
      lowPressureCmH2O: row?.lowPressureCmH2O ?? null,
      totalL: row?.totalL ?? null,
      rows: this.rows,
      gaps: this.gaps,
      lastGapMs: this.lastGapMs,
      humiditySaturated: (row?.humidityPct ?? 0) >= 99.5,
      error: this.error,
    }
  }

  // --- connection ------------------------------------------------------------

  private async connectAndStream(state: FlowMeterState): Promise<void> {
    this.setState(state, this.error)
    try {
      const host = await this.resolveHost()
      await this.open(host)
      await this.exclusive(async () => {
        await this.stopStream()
        await this.configure(host)
        await this.startStream()
      })
      this.error = null
      this.setState('connected', null)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.teardown()
      // A first connection that fails is reported to whoever asked. A dropped
      // connection that fails to come back keeps trying.
      if (state === 'connecting') {
        this.running = false
        this.setState('disconnected', this.error)
        throw error
      }
      this.scheduleReconnect()
    }
  }

  private async resolveHost(): Promise<string> {
    // An address the operator typed is the only one tried: falling back to
    // discovery would quietly connect to some other meter on the link.
    const found = this.opts.host ? [] : this.opts.candidates()
    const tries = [this.opts.host, this._host, ...found].filter(
      (h, i, all): h is string => !!h && all.indexOf(h) === i,
    )
    for (const host of tries) {
      if (await probe(host, this.opts.port)) return host
    }
    throw new Error(
      tries.length
        ? `No TSI meter answered on ${tries.join(', ')}. Is it switched on and connected by USB-C?`
        : 'No TSI meter link found. Connect the meter by USB-C and wait for it to boot.',
    )
  }

  private open(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      socket.setNoDelay(true)
      const fail = (error: Error) => reject(error)
      socket.once('error', fail)
      socket.connect(this.opts.port, host, () => {
        socket.off('error', fail)
        this.socket = socket
        this._host = host
        this.splitter.reset()
        socket.setEncoding('ascii')
        socket.on('data', (chunk: string) => this.onData(chunk))
        socket.on('error', (error) => {
          this.error = error.message
        })
        socket.on('close', () => this.onClose(socket))
        resolve()
      })
    })
  }

  private onClose(socket: Socket): void {
    if (socket !== this.socket) return
    this.closeSegment()
    this.nextStart = 'reconnect'
    this.teardown()
    if (!this.running) return
    this.error ??= 'Connection to the meter closed'
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return
    this.setState('reconnecting', this.error)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running) return
      this.nextStart = 'reconnect'
      void this.connectAndStream('reconnecting').catch(() => {})
    }, this.opts.reconnectMs)
  }

  private teardown(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.watchdog = null
    this.flushTimer = null
    this.drainTimer = null
    this.drainDone?.()
    this.drainDone = null
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Connection to the meter closed'))
    }
    this.lines = []
    this.mode = 'idle'
    const socket = this.socket
    this.socket = null
    socket?.destroy()
  }

  private setState(state: FlowMeterState, error: string | null): void {
    this._state = state
    this.opts.onState?.(state, error)
  }

  // --- conversation ------------------------------------------------------------

  /** Commands and restarts never interleave with each other. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.busy.then(task, task)
    this.busy = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private send(text: string): void {
    if (!this.socket) throw new Error('Not connected to the meter')
    this.socket.write(`${text}\r`)
  }

  private onData(chunk: string): void {
    const arrival = this.opts.now()
    this.lastDataAt = arrival
    for (const line of this.splitter.push(chunk)) {
      switch (this.mode) {
        case 'stream':
          this.onStreamLine(line, arrival)
          break
        case 'command':
          this.onCommandLine(line)
          break
        default:
          break
      }
    }
    if (this.mode === 'drain') this.armDrain()
  }

  private onCommandLine(line: string): void {
    const waiter = this.waiters.shift()
    if (!waiter) {
      this.lines.push(line)
      return
    }
    clearTimeout(waiter.timer)
    waiter.resolve(line)
  }

  private nextLine(): Promise<string> {
    const ready = this.lines.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer)
        reject(new Error('The meter did not reply'))
      }, REPLY_TIMEOUT_MS)
      this.waiters.push({ resolve, reject, timer })
    })
  }

  /** Sends a command and returns the value line after `OK`, if one is expected. */
  private async query(text: string, expectValue: boolean): Promise<string> {
    this.mode = 'command'
    this.lines = []
    this.send(text)
    const ack = parseLine(await this.nextLine())
    if (ack.kind === 'error') throw new Error(`${text} was refused (ERR${ack.code})`)
    if (ack.kind !== 'ok') throw new Error(`${text}: unexpected reply`)
    return expectValue ? (await this.nextLine()).trim() : ''
  }

  /** BREAK, then wait until the link has been quiet long enough that nothing is in flight. */
  private stopStream(): Promise<void> {
    this.mode = 'drain'
    this.drainStartedAt = this.opts.now()
    this.send(cmd.stop)
    return new Promise((resolve) => {
      this.drainDone = resolve
      this.armDrain()
    })
  }

  private armDrain(): void {
    // BREAK cancels a queued stream command too (measured), so data should stop
    // within a few rows. If it has not, say it again rather than wait forever.
    if (this.opts.now() - this.drainStartedAt > DRAIN_RETRY_MS && this.socket) {
      this.drainStartedAt = this.opts.now()
      this.send(cmd.stop)
    }
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      this.splitter.reset()
      this.mode = 'idle'
      const done = this.drainDone
      this.drainDone = null
      done?.()
    }, DRAIN_QUIET_MS)
  }

  private async configure(host: string): Promise<void> {
    const model = await this.query(cmd.model, true)
    const serial = await this.query(cmd.serial, true)
    const firmware = await this.query(cmd.firmware, true)
    const calibrationDate = await this.query(cmd.calibrationDate, true)
    await this.query(cmd.setRate(this.opts.rateMs), false)
    const flowUnits = await this.query(cmd.readUnits, true)
    const humidityCompensation = (await this.query(cmd.readHumidityComp, true)) === '1'
    const directionSensor = (await this.query(cmd.readDirection, true)) === '1'
    this._meter = {
      type: 'meter',
      at: this.opts.now(),
      host,
      model,
      serial,
      firmware,
      calibrationDate,
      rateMs: this.opts.rateMs,
      flowUnits,
      humidityCompensation,
      directionSensor,
    }
    this.opts.onMeter?.(this._meter)
  }

  private async command(
    kind: FlowCommandKind,
    commands: string[],
    applied?: () => void,
    detail?: string,
  ): Promise<FlowCommand> {
    return this.exclusive(async () => {
      let ok = false
      let message = detail
      try {
        if (!this.socket || this._state !== 'connected') throw new Error('The meter is not connected')
        this.closeSegment()
        this.nextStart = 'restart'
        await this.stopStream()
        for (const text of commands) await this.query(text, false)
        applied?.()
        ok = true
        if (kind === 'rate' && this._meter) this.opts.onMeter?.({ ...this._meter, at: this.opts.now() })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        message = detail ? `${detail}: ${reason}` : reason
      } finally {
        if (this.socket) {
          try {
            await this.startStream()
          } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
          }
        }
      }
      const record: FlowCommand = { type: 'command', at: this.opts.now(), command: kind, ok }
      if (message) record.detail = message
      this.opts.onCommand?.(record)
      return record
    })
  }

  // --- streaming -------------------------------------------------------------

  private async startStream(): Promise<void> {
    this.mode = 'stream'
    this.segment = null
    this.send(cmd.stream)
    this.lastDataAt = this.opts.now()
    if (!this.flushTimer) this.flushTimer = setInterval(() => this.flush(), this.opts.flushMs)
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkStalled(), 250)
  }

  private onStreamLine(line: string, arrival: number): void {
    const parsed = parseLine(line)
    switch (parsed.kind) {
      case 'ok':
        // The ack of a stream command. Either the first, or the queued one that
        // ran because the previous stream just ended.
        if (this.segment) {
          this.closeSegment()
          this.nextStart = 'continuous'
        }
        this.openSegment()
        break
      case 'row':
        if (!this.segment) this.openSegment()
        this.addRow(parsed.row, arrival)
        break
      case 'error':
        this.error = `The meter refused the stream (ERR${parsed.code})`
        break
      default:
        break
    }
  }

  private openSegment(): void {
    this.segment = {
      seg: this.nextSeg++,
      clock: new SegmentClock(this.opts.rateMs),
      start: this.nextStart,
      pending: { i0: 0, f: [], tc: [], p: [], rh: [], lp: [], tot: [] },
      firstRow: null,
      lastRow: null,
      queued: false,
    }
  }

  private addRow(row: TsiRow, arrival: number): void {
    const s = this.segment!
    const i = s.clock.add(arrival)
    if (s.pending.f.length === 0) s.pending.i0 = i
    s.pending.f.push(row.flow)
    s.pending.tc.push(row.tempC)
    s.pending.p.push(row.pressureKpa)
    s.pending.rh.push(row.humidityPct)
    s.pending.lp.push(row.lowPressureCmH2O)
    s.pending.tot.push(row.totalL)
    s.firstRow ??= row
    s.lastRow = row
    this.latest = row
    this.rows += 1
    this.flowSum += row.flow
    this.flowCount += 1

    const perSegment = Math.round(this.opts.segmentMs / this.opts.rateMs)
    const ahead = Math.max(1, Math.round(QUEUE_AHEAD_MS / this.opts.rateMs))
    if (!s.queued && s.clock.count >= perSegment - Math.min(ahead, perSegment / 2)) {
      s.queued = true
      this.send(cmd.stream)
    }
  }

  private flush(): void {
    const s = this.segment
    if (!s || s.pending.f.length === 0) return
    const { i0, ...channels } = s.pending
    this.opts.onBlock?.({
      type: 'block',
      seg: s.seg,
      i0,
      at0: s.clock.timeOf(i0),
      dt: this.opts.rateMs,
      ...channels,
    })
    s.pending = { i0: s.clock.count, f: [], tc: [], p: [], rh: [], lp: [], tot: [] }
  }

  private closeSegment(): void {
    const s = this.segment
    if (!s) return
    this.flush()
    this.segment = null
    const record = this.segmentRecord(s, false)
    if (!record) return
    if (record.gapBefore) {
      this.gaps += 1
      this.lastGapMs = record.gapBefore.ms
    }
    this.opts.onSegment?.(record)
    this.previous = { endMs: s.clock.endMs, lastRow: s.lastRow!, dt: s.clock.dtMs }
    this.totalizerResetSincePrevious = false
  }

  /**
   * Hands on the rows buffered so far and a provisional record for the segment
   * still streaming, without ending it. Used when a session stops writing in
   * the middle of a segment: without it, the rows written so far would have no
   * anchor at all, only their blocks' provisional times. The segment's own
   * record, when it ends, supersedes this one.
   */
  checkpoint(): void {
    const s = this.segment
    if (!s) return
    this.flush()
    const record = this.segmentRecord(s, true)
    if (record) this.opts.onSegment?.(record)
  }

  private segmentRecord(s: OpenSegment, partial: boolean): FlowSegment | null {
    if (s.clock.count === 0 || !s.firstRow || !s.lastRow) return null
    const dt = s.clock.dtMs
    let gapBefore: FlowSegment['gapBefore'] = null
    if (this.previous) {
      gapBefore = {
        samples: gapSamples(this.previous.endMs, s.clock.anchorMs, dt),
        ms: s.clock.anchorMs - this.previous.endMs - dt,
        volumeL: gapVolumeL(
          this.previous.lastRow.totalL,
          s.firstRow.totalL,
          s.firstRow.flow,
          dt,
          this.totalizerResetSincePrevious,
        ),
      }
    }
    const record: FlowSegment = {
      type: 'segment',
      seg: s.seg,
      anchorAt: s.clock.anchorMs,
      n: s.clock.count,
      dt,
      observedDt: s.clock.observedDtMs,
      start: s.start,
      gapBefore,
    }
    if (partial) record.partial = true
    return record
  }

  /**
   * A stream that stopped without the queued command taking over. Restart it;
   * the gap is measured like any other.
   */
  private checkStalled(): void {
    if (this.mode !== 'stream' || !this.socket) return
    const limit = Math.max(2000, 50 * this.opts.rateMs)
    if (this.opts.now() - this.lastDataAt < limit) return
    void this.exclusive(async () => {
      if (this.mode !== 'stream' || !this.socket) return
      this.closeSegment()
      this.nextStart = 'restart'
      await this.stopStream()
      await this.startStream()
    }).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error)
    })
  }
}

/** Whether something accepts a TCP connection at the address within a second. */
export function probe(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host, () => done(true))
  })
}
