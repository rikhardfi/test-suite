/** Live metric keys a sensor can contribute to the merged sample. */
export type MetricKey =
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'speedMs'
  | 'distanceM'
  | 'inclinePct'
  | 'resistance'
  /** CORE sensor: estimated core body temperature, °C. */
  | 'coreTempC'
  /** CORE sensor: skin temperature, °C. */
  | 'skinTempC'
  /** CORE sensor: heat strain index, 0 to 25.4. */
  | 'heatStrainIndex'
  /** CORE sensor: 0 invalid, 1 poor, 2 fair, 3 good, 4 excellent. */
  | 'coreQuality'
  /** CORE sensor: 0 HRM unsupported, 1 supported not receiving, 2 receiving. */
  | 'coreHrmState'
  /**
   * Share of power produced by the left leg, percent. A meter that measures one
   * side and doubles it reports a constant 50, which is the only signal
   * Bluetooth gives about how many legs a power figure rests on.
   */
  | 'pedalBalancePct'
  /** Ventilation wearable: minute ventilation, L/min. */
  | 'ventilationLMin'
  /** Ventilation wearable: breaths per minute. */
  | 'breathingRate'
  /**
   * TSI flow meter on the one-way expiratory limb: mean exhaled flow over the
   * last quarter second (Std L/min, dry-gas equivalent), gas temperature and
   * RH in the meter, its running volume (L), and breathing-circuit pressure.
   * Named apart from the environment keys, which are recorded on their own
   * slow channel and would otherwise catch these.
   */
  | 'expFlowLMin'
  | 'expTempC'
  | 'expHumidityPct'
  | 'expTotalL'
  | 'flowLowPressureCmH2O'
  /**
   * Environment monitor. These move on a scale of minutes, not seconds, and are
   * recorded on their own clock rather than sampled onto the 1 Hz series.
   */
  | 'co2Ppm'
  | 'ambientTempC'
  | 'humidityPct'
  | 'pressureHpa'

/** One decoded notification: whatever the packet happened to carry. */
export type MetricUpdate = Partial<Record<MetricKey, number>> & {
  /** Beat-to-beat intervals in ms, when the strap sends them. */
  rrIntervalsMs?: number[]
  /**
   * The controllable machine's own power, when a separate meter won `power`.
   *
   * Recorded as its own quantity and never blended into `power`. Two devices
   * measuring the same rider at different points in the drivetrain disagree by
   * a few percent on a good day, and by considerably more as a trainer warms
   * up; averaging them would produce a number neither device measured and hide
   * exactly the discrepancy worth seeing.
   */
  powerSecondaryW?: number
}

export type DeviceKind =
  | 'heartRate'
  | 'powerMeter'
  | 'speedCadence'
  | 'runningPod'
  | 'trainer'
  | 'treadmill'
  | 'coreTemp'
  | 'ventilation'
  | 'environment'
  | 'flowMeter'
  | 'mock'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** What a connected sensor exposes to the rest of the app. */
export interface SensorDevice {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  /** Metrics this device is capable of producing. */
  readonly provides: readonly MetricKey[]
  state: ConnectionState
  /** Present only on devices that accept ERG / speed targets. */
  control?: MachineControl
  batteryPct?: number
  /**
   * Links lost since the device was paired.
   *
   * A crank power meter that drops once is unremarkable; one that drops forty
   * times in a test is a battery, a magnet or a radio problem, and the only
   * place that shows is a counter. Kept across reconnections, since resetting
   * it on every recovery would hide exactly the pattern worth seeing.
   */
  drops?: number
  /** Failed reconnect attempts since the last successful one; 0 when connected. */
  reconnectAttempts?: number
  disconnect(): void
}

/** Controllable trainer or treadmill. */
export interface MachineControl {
  readonly canSetPower: boolean
  readonly canSetSpeed: boolean
  readonly canSetIncline: boolean
  readonly powerRange?: { min: number; max: number; step: number }
  readonly speedRange?: { min: number; max: number; step: number }
  requestControl(): Promise<void>
  setTargetPower(watts: number): Promise<void>
  setTargetSpeedKph(kph: number): Promise<void>
  setTargetInclinePct(pct: number): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export type MetricListener = (deviceId: string, update: MetricUpdate) => void
