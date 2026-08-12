/** Live metric keys a sensor can contribute to the merged sample. */
export type MetricKey =
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'speedMs'
  | 'distanceM'
  | 'inclinePct'
  | 'resistance'

/** One decoded notification: whatever the packet happened to carry. */
export type MetricUpdate = Partial<Record<MetricKey, number>> & {
  /** Beat-to-beat intervals in ms, when the strap sends them. */
  rrIntervalsMs?: number[]
}

export type DeviceKind =
  | 'heartRate'
  | 'powerMeter'
  | 'speedCadence'
  | 'runningPod'
  | 'trainer'
  | 'treadmill'
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
