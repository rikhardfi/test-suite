import type { MachineControl, SensorDevice } from './types'
import type { SensorManager } from './manager'

export interface SimulatorOptions {
  /** Power the rider can hold indefinitely; HR and drift scale off it. */
  ftpWatts?: number
  maxHr?: number
  restingHr?: number
  /** 0 = perfect robot, 1 = ragged human. */
  noise?: number
}

/**
 * A synthetic trainer and athlete, so the whole app can be exercised without
 * hardware. It answers ERG targets like a real trainer (first-order lag plus
 * pedalling noise) and drives a heart rate that lags power and drifts upward
 * above threshold, which is what makes step tests look plausible.
 */
export class Simulator implements SensorDevice, MachineControl {
  readonly id = 'sim:trainer'
  readonly name = 'Simulated trainer + athlete'
  readonly kind = 'mock' as const
  readonly provides = ['power', 'cadence', 'heartRate', 'speedMs', 'distanceM'] as const
  state = 'connected' as const

  readonly canSetPower = true
  readonly canSetSpeed = true
  readonly canSetIncline = true

  private targetPower = 100
  private targetSpeedMs = 3
  private power = 100
  private speedMs = 3
  private cadence = 90
  private hr: number
  private distanceM = 0
  private phase = 0
  private timer: ReturnType<typeof setInterval> | null = null

  private readonly ftp: number
  private readonly maxHr: number
  private readonly restingHr: number
  private readonly noise: number

  constructor(
    private readonly manager: SensorManager,
    options: SimulatorOptions = {},
  ) {
    this.ftp = options.ftpWatts ?? 320
    this.maxHr = options.maxHr ?? 190
    this.restingHr = options.restingHr ?? 52
    this.noise = options.noise ?? 1
    this.hr = this.restingHr + 12
  }

  get control(): MachineControl {
    return this
  }

  start(): Promise<void> {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 250)
    return Promise.resolve()
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return Promise.resolve()
  }

  requestControl(): Promise<void> {
    return Promise.resolve()
  }

  setTargetPower(watts: number): Promise<void> {
    this.targetPower = Math.max(0, watts)
    return Promise.resolve()
  }

  setTargetSpeedKph(kph: number): Promise<void> {
    this.targetSpeedMs = Math.max(0, kph / 3.6)
    return Promise.resolve()
  }

  setTargetInclinePct(): Promise<void> {
    return Promise.resolve()
  }

  disconnect(): void {
    void this.stop()
    this.manager.remove(this.id)
  }

  private tick(): void {
    const dt = 0.25
    this.phase += dt

    // Trainer chases the target; a pedal-stroke ripple keeps the trace honest.
    this.power += (this.targetPower - this.power) * 0.35
    const ripple = Math.sin(this.phase * 4.2) * this.targetPower * 0.03 * this.noise
    const jitter = (Math.random() - 0.5) * 14 * this.noise
    const power = Math.max(0, Math.round(this.power + ripple + jitter))

    this.speedMs += (this.targetSpeedMs - this.speedMs) * 0.25
    this.distanceM += this.speedMs * dt

    // Cadence sags a little as the effort climbs, the way legs actually do.
    const cadenceTarget = this.targetPower > 0 ? 95 - (this.targetPower / this.ftp) * 14 : 0
    this.cadence += (cadenceTarget - this.cadence) * 0.1

    // HR chases an intensity-derived steady state with a ~40 s time constant,
    // then keeps creeping once the effort is above threshold.
    const intensity = this.targetPower / this.ftp
    const steadyHr = this.restingHr + (this.maxHr - this.restingHr) * clamp(intensity * 0.86, 0, 1.02)
    const drift = intensity > 0.95 ? (intensity - 0.95) * 0.55 : 0
    this.hr += (steadyHr - this.hr) * (dt / 40) + drift * dt

    this.manager.ingest(this.id, {
      power,
      cadence: Math.max(0, Math.round(this.cadence + (Math.random() - 0.5) * 2 * this.noise)),
      heartRate: Math.round(clamp(this.hr, this.restingHr, this.maxHr + 4)),
      speedMs: Number(this.speedMs.toFixed(2)),
      distanceM: Math.round(this.distanceM),
    })
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
