import type { MachineControl, SensorDevice } from './types'
import type { SensorManager } from './manager'

export interface SimulatorOptions {
  /** Power the rider can hold indefinitely; HR and drift scale off it. */
  ftpWatts?: number
  maxHr?: number
  restingHr?: number
  /** 0 = perfect robot, 1 = ragged human. */
  noise?: number
  /**
   * A second power source, so the dual-source path can be exercised without
   * two real devices.
   *
   * The defaults reproduce the failure this app exists to catch, measured from
   * a real session on 14 August 2026: the meter reads about 5% above the
   * trainer at the start and drifts down through it as the unit warms, while
   * the trainer holds its own number at the commanded target throughout. Left
   * alone, that is 12 W of load quietly leaving a test that says 200 W from
   * beginning to end.
   */
  referenceMeter?: {
    /** Drivetrain loss plus calibration offset, at the start. */
    biasPct?: number
    /** How fast the trainer's own estimate climbs, in points of bias per hour. */
    driftPctPerHour?: number
    /** False makes it report a constant 50/50, the way a one-sided meter does. */
    dualSided?: boolean
  }
}

/**
 * A power meter that disagrees with the trainer, the way a real one does.
 *
 * Registered as its own device with its own kind, so it wins `power` under the
 * normal arbitration and the trainer's reading becomes the secondary trace.
 * Nothing here is special-cased downstream: the app cannot tell it from a pair
 * of real devices.
 */
class SimulatedPowerMeter implements SensorDevice {
  readonly id = 'sim:meter'
  readonly name = 'Simulated pedal power meter'
  readonly kind = 'powerMeter' as const
  readonly provides = ['power', 'cadence', 'pedalBalancePct'] as const
  state = 'connected' as const

  constructor(private readonly manager: SensorManager) {}

  disconnect(): void {
    this.manager.remove(this.id)
  }
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
  readonly provides = [
    'power',
    'cadence',
    'heartRate',
    'speedMs',
    'distanceM',
    'coreTempC',
    'skinTempC',
    'heatStrainIndex',
    'coreQuality',
    'coreHrmState',
    'ambientTempC',
    'humidityPct',
    'pressureHpa',
    'co2Ppm',
  ] as const
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
  private coreTempC = 37.0
  private skinTempC = 32.5
  private phase = 0
  /** When the room was last reported; null until the first tick. */
  private roomReportedAtS: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  private readonly ftp: number
  private readonly maxHr: number
  private readonly restingHr: number
  private readonly noise: number
  private readonly meterOptions: SimulatorOptions['referenceMeter']
  private meter: SimulatedPowerMeter | null = null
  /** Seconds since the simulator started, for the warming drift. */
  private runtimeS = 0

  constructor(
    private readonly manager: SensorManager,
    options: SimulatorOptions = {},
  ) {
    this.ftp = options.ftpWatts ?? 320
    this.maxHr = options.maxHr ?? 190
    this.restingHr = options.restingHr ?? 52
    this.noise = options.noise ?? 1
    this.meterOptions = options.referenceMeter
    this.hr = this.restingHr + 12
  }

  /**
   * Adds the second power source, if one was asked for.
   *
   * Separate from the constructor because it registers a device, and a
   * constructor that reaches into the manager is a constructor with a surprise
   * in it.
   */
  attachReferenceMeter(): SensorDevice | null {
    if (!this.meterOptions || this.meter) return this.meter
    this.meter = new SimulatedPowerMeter(this.manager)
    this.manager.addVirtual(this.meter)
    return this.meter
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
    this.runtimeS += dt

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

    // Core temperature climbs slowly with intensity and falls back towards
    // baseline when the work stops. The time constant is minutes, not seconds,
    // which is the whole point of measuring it: it lags everything else.
    const coreTarget = 36.9 + clamp(intensity, 0, 1.3) * 1.6
    this.coreTempC += (coreTarget - this.coreTempC) * (dt / 420)
    // Skin runs cooler and responds faster, and is pulled down by airflow.
    const skinTarget = 32.2 + clamp(intensity, 0, 1.3) * 1.4 - this.speedMs * 0.05
    this.skinTempC += (skinTarget - this.skinTempC) * (dt / 90)

    this.manager.ingest(this.id, {
      power,
      cadence: Math.max(0, Math.round(this.cadence + (Math.random() - 0.5) * 2 * this.noise)),
      heartRate: Math.round(clamp(this.hr, this.restingHr, this.maxHr + 4)),
      speedMs: Number(this.speedMs.toFixed(2)),
      distanceM: Math.round(this.distanceM),
      coreTempC: Number(this.coreTempC.toFixed(2)),
      skinTempC: Number(this.skinTempC.toFixed(2)),
      // Heat strain index as CORE reports it: 0 to 10 in normal use.
      heatStrainIndex: Number(clamp((this.coreTempC - 36.8) * 4.5, 0, 25.4).toFixed(1)),
      coreQuality: 3,
      coreHrmState: 2,
    })

    // The room speaks once a minute and on its own, as a real monitor does.
    // Sent with every tick it would be recorded with every tick.
    if (this.roomReportedAtS === null || this.runtimeS - this.roomReportedAtS >= 60) {
      this.roomReportedAtS = this.runtimeS
      const minutes = this.runtimeS / 60
      this.manager.ingest(this.id, {
        // A closed room with somebody working hard in it: warmer, damper and
        // more CO₂ as the session goes on.
        ambientTempC: Number((21 + Math.min(2, minutes * 0.03)).toFixed(1)),
        humidityPct: Math.round(40 + Math.min(12, minutes * 0.15)),
        pressureHpa: 1003.2,
        co2Ppm: Math.round(620 + Math.min(900, minutes * 12)),
      })
    }

    if (this.meter) {
      // The trainer holds *its own* reading at the target, so the meter is what
      // moves: it starts high by the drivetrain bias and is dragged down as the
      // trainer's estimate climbs with heat. Exactly the pattern that makes a
      // constant-load session drift while every label stays put.
      const bias = this.meterOptions?.biasPct ?? 4.9
      const driftPerHour = this.meterOptions?.driftPctPerHour ?? -6.7
      const offsetPct = bias + (driftPerHour * this.runtimeS) / 3600
      const meterPower = Math.max(0, Math.round(power * (1 + offsetPct / 100)))
      this.manager.ingest(this.meter.id, {
        power: meterPower,
        cadence: Math.max(0, Math.round(this.cadence)),
        // A one-sided meter halves a leg and doubles it again, so it reports
        // exactly 50 forever. A real dual-sided one never sits still.
        pedalBalancePct:
          this.meterOptions?.dualSided === false
            ? 50
            : Number((49.5 + Math.sin(this.phase * 0.7) * 2).toFixed(1)),
      })
    }
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
