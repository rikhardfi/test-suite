import { CHR, SVC } from './uuids'
import {
  RevolutionCounter,
  parseCsc,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  parseRsc,
  parseTreadmillData,
} from './parse'
import { FtmsControl, readFtmsCapabilities } from './ftms'
import type {
  DeviceKind,
  MetricKey,
  MetricListener,
  MetricUpdate,
  SensorDevice,
} from './types'

export const isWebBluetoothAvailable = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.bluetooth

/** Sensor roles the user can add, each mapping to a `requestDevice` filter. */
export interface SensorProfile {
  key: string
  label: string
  hint: string
  kind: DeviceKind
  service: number
  provides: readonly MetricKey[]
}

export const SENSOR_PROFILES: readonly SensorProfile[] = [
  {
    key: 'hr',
    label: 'Heart rate',
    hint: 'Chest strap or optical band',
    kind: 'heartRate',
    service: SVC.heartRate,
    provides: ['heartRate'],
  },
  {
    key: 'power',
    label: 'Power meter',
    hint: 'Crank, pedal or hub power',
    kind: 'powerMeter',
    service: SVC.cyclingPower,
    provides: ['power', 'cadence'],
  },
  {
    key: 'ftms',
    label: 'Trainer / treadmill',
    hint: 'FTMS — required for ERG and pace control',
    kind: 'trainer',
    service: SVC.fitnessMachine,
    provides: ['power', 'cadence', 'speedMs', 'distanceM', 'inclinePct', 'resistance'],
  },
  {
    key: 'rsc',
    label: 'Running pod',
    hint: 'Foot pod speed and cadence',
    kind: 'runningPod',
    service: SVC.runningSpeedCadence,
    provides: ['speedMs', 'cadence', 'distanceM'],
  },
  {
    key: 'csc',
    label: 'Speed / cadence',
    hint: 'Magnet or accelerometer sensor',
    kind: 'speedCadence',
    service: SVC.cyclingSpeedCadence,
    provides: ['speedMs', 'cadence'],
  },
]

/**
 * When two devices report the same metric, the one whose role is more
 * authoritative wins. A dedicated power meter beats a trainer's estimate; a
 * chest strap beats the heart rate relayed inside FTMS data.
 */
const KIND_PRIORITY: Record<MetricKey, DeviceKind[]> = {
  power: ['powerMeter', 'trainer', 'treadmill', 'mock'],
  heartRate: ['heartRate', 'trainer', 'treadmill', 'mock'],
  cadence: ['powerMeter', 'speedCadence', 'runningPod', 'trainer', 'treadmill', 'mock'],
  speedMs: ['treadmill', 'runningPod', 'trainer', 'speedCadence', 'mock'],
  distanceM: ['treadmill', 'runningPod', 'trainer', 'speedCadence', 'mock'],
  inclinePct: ['treadmill', 'trainer', 'mock'],
  resistance: ['trainer', 'treadmill', 'mock'],
}

/** A value older than this is not shown, so a dropped sensor blanks out. */
const STALE_MS = 5000

interface Entry {
  device: SensorDevice
  values: Map<MetricKey, { value: number; at: number }>
  rrIntervalsMs?: number[]
  gattDevice?: BluetoothDevice
  ftms?: FtmsControl
}

export class SensorManager {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private metricListeners = new Set<MetricListener>()
  /** Explicit user override of which device owns a metric. */
  private preferred = new Map<MetricKey, string>()
  private wheelCircumferenceM = 2.096

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onMetric(fn: MetricListener): () => void {
    this.metricListeners.add(fn)
    return () => this.metricListeners.delete(fn)
  }

  private emit(): void {
    this.cachedDevices = null
    for (const fn of this.listeners) fn()
  }

  private cachedDevices: SensorDevice[] | null = null

  /** Stable identity between emits, so React can subscribe to it directly. */
  get devices(): SensorDevice[] {
    if (!this.cachedDevices) {
      this.cachedDevices = [...this.entries.values()].map((e) => e.device)
    }
    return this.cachedDevices
  }

  setWheelCircumference(metres: number): void {
    this.wheelCircumferenceM = metres
  }

  setPreferredSource(metric: MetricKey, deviceId: string | null): void {
    if (deviceId) this.preferred.set(metric, deviceId)
    else this.preferred.delete(metric)
    this.emit()
  }

  getPreferredSource(metric: MetricKey): string | null {
    return this.preferred.get(metric) ?? null
  }

  /** Device currently supplying a metric, after preference and staleness. */
  sourceFor(metric: MetricKey, now = Date.now()): SensorDevice | null {
    const preferredId = this.preferred.get(metric)
    if (preferredId) {
      const entry = this.entries.get(preferredId)
      const held = entry?.values.get(metric)
      if (entry && held && now - held.at < STALE_MS) return entry.device
    }

    const order = KIND_PRIORITY[metric]
    let best: { device: SensorDevice; rank: number } | null = null
    for (const entry of this.entries.values()) {
      const held = entry.values.get(metric)
      if (!held || now - held.at >= STALE_MS) continue
      const rank = order.indexOf(entry.device.kind)
      const effective = rank === -1 ? order.length : rank
      if (!best || effective < best.rank) best = { device: entry.device, rank: effective }
    }
    return best?.device ?? null
  }

  /** Merged live snapshot across all connected sensors. */
  read(now = Date.now()): MetricUpdate {
    const out: MetricUpdate = {}
    for (const metric of Object.keys(KIND_PRIORITY) as MetricKey[]) {
      const device = this.sourceFor(metric, now)
      if (!device) continue
      const held = this.entries.get(device.id)?.values.get(metric)
      if (held) out[metric] = held.value
    }
    const hrEntry = this.sourceFor('heartRate', now)
    const rr = hrEntry ? this.entries.get(hrEntry.id)?.rrIntervalsMs : undefined
    if (rr?.length) out.rrIntervalsMs = rr
    return out
  }

  /** The controllable machine, if one is connected. */
  get machine(): SensorDevice | null {
    for (const entry of this.entries.values()) {
      if (entry.device.control) return entry.device
    }
    return null
  }

  /** Registers a device that is not backed by GATT (the simulator). */
  addVirtual(device: SensorDevice): void {
    this.entries.set(device.id, { device, values: new Map() })
    this.emit()
  }

  ingest(deviceId: string, update: MetricUpdate): void {
    const entry = this.entries.get(deviceId)
    if (!entry) return
    const now = Date.now()
    for (const [key, value] of Object.entries(update)) {
      if (key === 'rrIntervalsMs') {
        entry.rrIntervalsMs = value as number[]
        continue
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        entry.values.set(key as MetricKey, { value, at: now })
      }
    }
    for (const fn of this.metricListeners) fn(deviceId, update)
  }

  /** Prompts the browser chooser and connects the selected device. */
  async connect(profile: SensorProfile): Promise<SensorDevice> {
    if (!isWebBluetoothAvailable()) {
      throw new Error('Web Bluetooth is not available in this browser.')
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [profile.service] }],
      optionalServices: [SVC.battery, SVC.deviceInformation, profile.service],
    })

    const id = device.id || `${profile.key}:${device.name ?? 'device'}`
    const existing = this.entries.get(id)
    if (existing && existing.device.state === 'connected') return existing.device

    const sensor: SensorDevice = {
      id,
      name: device.name ?? profile.label,
      kind: profile.kind,
      provides: profile.provides,
      state: 'connecting',
      disconnect: () => {
        this.entries.get(id)?.gattDevice?.gatt?.disconnect()
      },
    }

    const entry: Entry = { device: sensor, values: new Map(), gattDevice: device }
    this.entries.set(id, entry)
    this.emit()

    device.addEventListener('gattserverdisconnected', () => {
      entry.ftms?.forgetControl()
      sensor.state = 'reconnecting'
      this.emit()
      void this.reconnect(entry, profile)
    })

    try {
      await this.openSession(entry, profile)
    } catch (error) {
      sensor.state = 'disconnected'
      this.entries.delete(id)
      this.emit()
      throw error
    }

    sensor.state = 'connected'
    this.emit()
    return sensor
  }

  /** Reconnects with backoff until the device returns or is removed. */
  private async reconnect(entry: Entry, profile: SensorProfile): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!this.entries.has(entry.device.id)) return
      await delay(Math.min(1000 * 2 ** attempt, 15000))
      if (!this.entries.has(entry.device.id)) return
      try {
        await this.openSession(entry, profile)
        entry.device.state = 'connected'
        this.emit()
        return
      } catch {
        // Device still out of range; keep trying.
      }
    }
    entry.device.state = 'disconnected'
    this.emit()
  }

  private async openSession(entry: Entry, profile: SensorProfile): Promise<void> {
    const gatt = entry.gattDevice?.gatt
    if (!gatt) throw new Error('Device has no GATT server')
    const server = gatt.connected ? gatt : await gatt.connect()
    const service = await server.getPrimaryService(profile.service)

    switch (profile.key) {
      case 'hr':
        await this.notify(entry, service, CHR.heartRateMeasurement, parseHeartRate)
        break

      case 'power': {
        const crank = new RevolutionCounter(1024, 0x10000)
        const wheel = new RevolutionCounter(2048, 0x100000000)
        await this.notify(entry, service, CHR.cyclingPowerMeasurement, (v) =>
          parseCyclingPower(v, crank, wheel, this.wheelCircumferenceM),
        )
        break
      }

      case 'csc': {
        const crank = new RevolutionCounter(1024, 0x10000)
        const wheel = new RevolutionCounter(1024, 0x100000000)
        await this.notify(entry, service, CHR.cscMeasurement, (v) =>
          parseCsc(v, crank, wheel, this.wheelCircumferenceM),
        )
        break
      }

      case 'rsc':
        await this.notify(entry, service, CHR.rscMeasurement, parseRsc)
        break

      case 'ftms':
        await this.openFtms(entry, service)
        break
    }

    void this.readBattery(entry, server)
  }

  private async openFtms(entry: Entry, service: BluetoothRemoteGATTService): Promise<void> {
    // A machine advertises exactly one of these data characteristics, and which
    // one it is settles whether we are driving watts or pace.
    const bike = await this.notify(entry, service, CHR.indoorBikeData, parseIndoorBikeData)
    const treadmill = bike
      ? false
      : await this.notify(entry, service, CHR.treadmillData, parseTreadmillData)

    if (!bike && !treadmill) {
      throw new Error('Fitness machine exposes neither indoor bike nor treadmill data')
    }
    Object.assign(entry.device, { kind: treadmill ? 'treadmill' : 'trainer' })

    const { features, powerRange, speedRange } = await readFtmsCapabilities(service)
    const controlPoint = await service.getCharacteristic(CHR.fitnessMachineControlPoint)
    await controlPoint.startNotifications()
    const control = new FtmsControl(controlPoint, features, powerRange, speedRange)
    entry.ftms = control
    entry.device.control = control
  }

  /** Subscribes to a characteristic; resolves false when it is absent. */
  private async notify(
    entry: Entry,
    service: BluetoothRemoteGATTService,
    uuid: number,
    parse: (view: DataView) => MetricUpdate,
  ): Promise<boolean> {
    let chr: BluetoothRemoteGATTCharacteristic
    try {
      chr = await service.getCharacteristic(uuid)
    } catch {
      return false
    }

    chr.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value
      if (!value) return
      try {
        this.ingest(entry.device.id, parse(value))
      } catch {
        // A malformed packet must not tear down the notification stream.
      }
    })
    await chr.startNotifications()
    return true
  }

  private async readBattery(entry: Entry, server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const service = await server.getPrimaryService(SVC.battery)
      const chr = await service.getCharacteristic(CHR.batteryLevel)
      entry.device.batteryPct = (await chr.readValue()).getUint8(0)
      this.emit()
    } catch {
      // Battery service is optional.
    }
  }

  remove(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (!entry) return
    this.entries.delete(deviceId)
    entry.ftms?.forgetControl()
    try {
      entry.gattDevice?.gatt?.disconnect()
    } catch {
      // Already gone.
    }
    for (const [metric, id] of this.preferred) {
      if (id === deviceId) this.preferred.delete(metric)
    }
    this.emit()
  }

  removeAll(): void {
    for (const id of [...this.entries.keys()]) this.remove(id)
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
