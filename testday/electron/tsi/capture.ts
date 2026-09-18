import { join } from 'node:path'
import { FLOW_FILE, type FlowCommand, type FlowMeterStatus, type FlowRecord } from '../../src/model/flow'
import type { JournalEventKind } from '../../src/model/journal'
import { JournalWriter } from '../journal'
import { TsiMeter, type TsiMeterOptions } from './meter'
import { RATES_MS } from './protocol'

const STATUS_MS = 250
/** Failed flow writes held for a retry: ten minutes of blocks at one a second. */
const MAX_HELD = 600

export interface FlowConnectOptions {
  host?: string
  rateMs: number
}

export interface FlowCaptureDeps {
  pushStatus(status: FlowMeterStatus): void
  /** Appends an event to the session journal, if a session is open. */
  journalEvent(kind: JournalEventKind, data: Record<string, number | string | boolean>): void
  /** A write that did not reach the disk. Shown in the recording pill. */
  writeFailed(message: string): void
  info(message: string, data?: Record<string, unknown>): void
  /** Overrides for the meter client. Tests point it at the emulator. */
  meter?: Partial<TsiMeterOptions>
}

/**
 * The flow meter as the recording process sees it: one meter, streaming for as
 * long as it is connected so the dashboard always has live values, and written
 * to disk only while a session is open.
 *
 * The meter's rows never cross to the renderer. They go straight to
 * `flow.ndjson` in blocks, and the interface gets a status a few times a
 * second, which is all a dashboard tile can show anyway.
 */
export class FlowCapture {
  private readonly deps: FlowCaptureDeps
  private meter: TsiMeter | null = null
  private writer: JournalWriter<FlowRecord> | null = null
  private held: FlowRecord[] = []
  private statusTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: FlowCaptureDeps) {
    this.deps = deps
  }

  get recording(): boolean {
    return this.writer !== null
  }

  /**
   * Points capture at a session directory, or stops writing when null. Called
   * when a session begins, resumes, closes or is detached.
   */
  attach(dir: string | null): void {
    // Rows of the segment still streaming must leave with an anchor, or the
    // end of this session would carry only provisional times.
    if (this.writer) this.meter?.checkpoint()
    this.flushHeld()
    this.writer?.close()
    this.writer = null
    this.held = []
    if (!dir) return
    this.writer = new JournalWriter<FlowRecord>(join(dir, FLOW_FILE))
    this.recordMeter()
  }

  async connect(options: FlowConnectOptions): Promise<FlowMeterStatus> {
    if (!RATES_MS.includes(options.rateMs as (typeof RATES_MS)[number])) {
      throw new Error(`Sample rate must be one of ${RATES_MS.join(', ')} ms`)
    }
    await this.disconnect()
    const meter = new TsiMeter({
      ...this.deps.meter,
      host: options.host?.trim() || undefined,
      rateMs: options.rateMs,
      onBlock: (block) => this.write(block),
      onSegment: (segment) => this.write(segment),
      onMeter: (record) => {
        this.write(record)
        this.deps.info('flow meter configured', { serial: record.serial, rateMs: record.rateMs })
      },
      onCommand: (command) => this.write(command),
      onState: (state, error) => {
        this.deps.info('flow meter state', { state, error })
        this.pushNow()
      },
    })
    this.meter = meter
    this.statusTimer = setInterval(() => this.pushNow(), STATUS_MS)
    try {
      await meter.start()
    } catch (error) {
      this.pushNow()
      this.stopStatus()
      this.meter = null
      throw error
    }
    this.journalMeter()
    return meter.status()
  }

  async disconnect(): Promise<void> {
    const meter = this.meter
    if (!meter) return
    this.meter = null
    await meter.stop()
    this.stopStatus()
    this.deps.pushStatus(meter.status())
  }

  zero(): Promise<FlowCommand> {
    return this.run((m) => m.zeroLowPressure(), 'flowZero')
  }

  resetTotal(): Promise<FlowCommand> {
    return this.run((m) => m.resetTotalizer(), 'flowTotalizerReset')
  }

  /** Refused while recording: a session keeps one rate from start to finish. */
  async setRate(ms: number): Promise<FlowCommand> {
    if (this.recording) throw new Error('The sample rate cannot change while a session is recording')
    if (!RATES_MS.includes(ms as (typeof RATES_MS)[number])) {
      throw new Error(`Sample rate must be one of ${RATES_MS.join(', ')} ms`)
    }
    return this.run((m) => m.setRate(ms), 'flowRate')
  }

  status(): FlowMeterStatus | null {
    return this.meter?.status() ?? null
  }

  /** Closes the file and the connection. For quitting. */
  async shutdown(): Promise<void> {
    this.attach(null)
    await this.disconnect()
  }

  private async run(
    task: (meter: TsiMeter) => Promise<FlowCommand>,
    kind: JournalEventKind,
  ): Promise<FlowCommand> {
    if (!this.meter) throw new Error('The flow meter is not connected')
    const result = await task(this.meter)
    const data: Record<string, number | string | boolean> = { ok: result.ok }
    if (result.detail) data.detail = result.detail
    this.deps.journalEvent(kind, data)
    this.pushNow()
    return result
  }

  private recordMeter(): void {
    const meter = this.meter?.meter
    if (!meter) return
    this.write({ ...meter, at: Date.now() })
    this.journalMeter()
  }

  private journalMeter(): void {
    const meter = this.meter?.meter
    if (!meter || !this.writer) return
    this.deps.journalEvent('flowMeter', {
      model: meter.model,
      serial: meter.serial,
      firmware: meter.firmware,
      calibrationDate: meter.calibrationDate,
      rateMs: meter.rateMs,
      flowUnits: meter.flowUnits,
      humidityCompensation: meter.humidityCompensation,
      directionSensor: meter.directionSensor,
    })
  }

  private write(record: FlowRecord): void {
    if (!this.writer) return
    this.flushHeld()
    try {
      this.writer.append(record)
    } catch (error) {
      if (this.held.length < MAX_HELD) this.held.push(record)
      this.deps.writeFailed(
        `Flow meter data not written: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private flushHeld(): void {
    if (!this.writer || this.held.length === 0) return
    try {
      this.writer.appendAll(this.held)
      this.held = []
    } catch {
      // Still failing; the next write reports it.
    }
  }

  private pushNow(): void {
    if (this.meter) this.deps.pushStatus(this.meter.status())
  }

  private stopStatus(): void {
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
  }
}
