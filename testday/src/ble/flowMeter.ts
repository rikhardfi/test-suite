import type { Exhalation } from '../model/breaths'
import type { CircuitMarker, FlowCommand, FlowMeterStatus } from '../model/flow'
import type { SensorManager } from './manager'
import type { ConnectionState, MetricKey, SensorDevice } from './types'

export const FLOW_METER_ID = 'tsi:flow'

/**
 * The TSI 5330 as a sensor the dashboard can read.
 *
 * A thin shadow: the meter itself is driven by the recording process, which
 * owns the socket and writes every row to `flow.ndjson`. What reaches this side
 * is a status four times a second, and that is what the tiles show. These
 * updates are therefore not the measurement, and are kept out of the raw
 * stream in the journal (see `App.tsx`).
 */
export class FlowMeterDevice implements SensorDevice {
  readonly id = FLOW_METER_ID
  readonly kind = 'flowMeter' as const
  readonly provides: readonly MetricKey[] = [
    'expFlowLMin',
    'expTempC',
    'expHumidityPct',
    'expTotalL',
    'flowLowPressureCmH2O',
  ]
  state: ConnectionState = 'connecting'
  name = 'TSI flow meter'
  private readonly manager: SensorManager
  private unsubscribe: (() => void) | null = null
  private latest: FlowMeterStatus | null = null
  private readonly listeners = new Set<(status: FlowMeterStatus) => void>()
  private log: Exhalation[] = []

  constructor(manager: SensorManager) {
    this.manager = manager
  }

  get status(): FlowMeterStatus | null {
    return this.latest
  }

  /** Every exhalation since the meter connected, oldest first. */
  get exhalations(): readonly Exhalation[] {
    return this.log
  }

  /** Connects the meter. Rejects with the recording process's own explanation. */
  async start(options: { host?: string; rateMs: number }): Promise<void> {
    const bridge = window.testday
    if (!bridge) throw new Error('The flow meter needs the desktop app: a browser cannot open its connection.')
    this.unsubscribe ??= bridge.onFlowStatus((status) => this.onStatus(status))
    this.manager.addVirtual(this)
    try {
      this.onStatus(await bridge.flowConnect(options))
    } catch (error) {
      this.unsubscribe?.()
      this.unsubscribe = null
      this.manager.remove(this.id)
      throw error
    }
  }

  disconnect(): void {
    this.log = []
    void window.testday?.flowDisconnect()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.manager.remove(this.id)
  }

  zero(): Promise<FlowCommand> {
    return this.bridge().flowZero()
  }

  resetTotal(): Promise<FlowCommand> {
    return this.bridge().flowResetTotal()
  }

  setRate(ms: number): Promise<FlowCommand> {
    return this.bridge().flowRate(ms)
  }

  /** Marks a condition on the circuit; the recording process journals it. */
  async mark(label: CircuitMarker, on: boolean): Promise<void> {
    const status = await this.bridge().flowMarker(label, on)
    if (status) this.onStatus(status)
  }

  onChange(listener: (status: FlowMeterStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bridge() {
    const bridge = window.testday
    if (!bridge) throw new Error('The flow meter needs the desktop app')
    return bridge
  }

  private onStatus(status: FlowMeterStatus): void {
    this.latest = status
    if (status.breaths) this.merge(status.breaths)
    this.state = status.state
    if (status.meter) this.name = `TSI ${status.meter.model} · ${status.meter.serial}`
    for (const listener of this.listeners) listener(status)
    if (status.state !== 'connected') return
    // Humidity at saturation is condensation, not a measurement, so it is not
    // offered as a value the dashboard would show as if it were one.
    this.manager.ingest(this.id, {
      expFlowLMin: status.flowLMin ?? undefined,
      expTempC: status.tempC ?? undefined,
      expHumidityPct: status.humiditySaturated ? undefined : status.humidityPct ?? undefined,
      expTotalL: status.totalL ?? undefined,
      flowLowPressureCmH2O: status.lowPressureCmH2O ?? undefined,
    })
  }

  /**
   * The status carries every exhalation in its window. Those starting in the
   * window's first second are kept from earlier statuses instead, because
   * there a breath can be cut by the window's edge and dropped, though an
   * earlier window saw it whole.
   */
  private merge({ from, exhalations }: NonNullable<FlowMeterStatus['breaths']>): void {
    const cut = from + 1000
    let keep = this.log.length
    while (keep > 0 && this.log[keep - 1].startAt >= cut) keep -= 1
    const next = this.log.slice(Math.max(0, keep - MAX_LOGGED), keep)
    for (const breath of exhalations) {
      if (breath.startAt < cut) continue
      // The same breath timed a few ms apart by two statuses is one breath.
      const last = next[next.length - 1]
      if (last && breath.startAt - last.startAt < 100) continue
      next.push(breath)
    }
    this.log = next
  }
}

/** About eight hours of breathing. */
const MAX_LOGGED = 20_000
