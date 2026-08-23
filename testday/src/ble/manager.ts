import { ARANET_CHR, ARANET_SVC, CHR, CORE_CHR, CORE_SVC, SVC } from './uuids'
import {
  RevolutionCounter,
  parseAranet,
  parseCoreTemperature,
  parseCsc,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  parseRsc,
  parseTreadmillData,
} from './parse'
import { FtmsControl, readFtmsCapabilities } from './ftms'
import { staleAfterMs } from './metrics'
import { TraceRecorder } from './trace'
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
  /** A SIG-assigned 16-bit number, or a full UUID for a vendor service. */
  service: number | string
  provides: readonly MetricKey[]
  /**
   * `environment` marks a device whose readings move on a scale of minutes.
   * They are recorded on their own clock rather than sampled onto the 1 Hz
   * series, because a five-minute value carried at 1 Hz is 299 repeats and one
   * measurement, and nothing downstream can tell which is which.
   */
  channel?: 'metric' | 'environment'
  /**
   * Set when the device may refuse to talk until it has been bonded, which Web
   * Bluetooth cannot do. Surfaced in the interface so a failure to connect
   * reads as a known limitation rather than as a bug.
   */
  mayRequirePairing?: boolean
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
  {
    key: 'core',
    label: 'CORE body temperature',
    hint: 'Core and skin temperature, heat strain index',
    kind: 'coreTemp',
    service: CORE_SVC,
    provides: ['coreTempC', 'skinTempC', 'heatStrainIndex', 'coreQuality', 'coreHrmState', 'heartRate'],
  },
  {
    key: 'aranet',
    label: 'Aranet4 air quality',
    hint: 'CO₂, temperature, humidity, pressure. May need pairing.',
    kind: 'environment',
    service: ARANET_SVC,
    provides: ['co2Ppm', 'ambientTempC', 'humidityPct', 'pressureHpa'],
    // Every one of these moves on a scale of minutes. Recorded on its own
    // clock, summarised per session, and never resampled up to 1 Hz.
    channel: 'environment',
    // Recent firmware bonds before it will hand over a reading, and Web
    // Bluetooth cannot drive a passkey flow. Whether this works is a question
    // about the firmware in front of you.
    mayRequirePairing: true,
  },
]

/**
 * When two devices report the same metric, the one whose role is more
 * authoritative wins. A dedicated power meter beats a trainer's estimate; a
 * chest strap beats the heart rate relayed inside FTMS data.
 */
const KIND_PRIORITY: Record<MetricKey, DeviceKind[]> = {
  power: ['powerMeter', 'trainer', 'treadmill', 'mock'],
  // CORE relays the strap it is paired to, so it ranks below a strap read
  // directly but above a machine's own estimate.
  heartRate: ['heartRate', 'coreTemp', 'trainer', 'treadmill', 'mock'],
  cadence: ['powerMeter', 'speedCadence', 'runningPod', 'trainer', 'treadmill', 'mock'],
  speedMs: ['treadmill', 'runningPod', 'trainer', 'speedCadence', 'mock'],
  distanceM: ['treadmill', 'runningPod', 'trainer', 'speedCadence', 'mock'],
  inclinePct: ['treadmill', 'trainer', 'mock'],
  resistance: ['trainer', 'treadmill', 'mock'],
  // Only a real power meter reports this; a trainer's estimate has no sides.
  pedalBalancePct: ['powerMeter', 'mock'],
  coreTempC: ['coreTemp', 'mock'],
  skinTempC: ['coreTemp', 'mock'],
  heatStrainIndex: ['coreTemp', 'mock'],
  coreQuality: ['coreTemp', 'mock'],
  coreHrmState: ['coreTemp', 'mock'],
  ventilationLMin: ['ventilation', 'mock'],
  breathingRate: ['ventilation', 'mock'],
  co2Ppm: ['environment', 'mock'],
  ambientTempC: ['environment', 'mock'],
  humidityPct: ['environment', 'mock'],
  pressureHpa: ['environment', 'mock'],
}

/** How long beat intervals are kept for a rolling variability window. */
const RR_HISTORY_MS = 5 * 60 * 1000

/** Attempts before giving up on a device when no session is being recorded. */
const IDLE_RECONNECT_ATTEMPTS = 12
const MAX_BACKOFF_MS = 15000

/** One metric changing hands, from one device to another or to nothing. */
export interface SourceChange {
  metric: MetricKey
  from: string | null
  to: string | null
  toName: string | null
}

export type SourceChangeListener = (changes: readonly SourceChange[]) => void

interface Entry {
  device: SensorDevice
  values: Map<MetricKey, { value: number; at: number }>
  rrIntervalsMs?: number[]
  gattDevice?: BluetoothDevice
  ftms?: FtmsControl
  /** Held so a device can be reconnected without the caller supplying it again. */
  profile?: SensorProfile
  reconnectAttempts?: number
  /** Set for devices that are polled rather than notified, e.g. the Aranet. */
  pollTimer?: ReturnType<typeof setInterval>
}

export class SensorManager {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private metricListeners = new Set<MetricListener>()
  private sourceListeners = new Set<SourceChangeListener>()
  /** Which device last won each metric, for spotting the moment it changes. */
  private lastSources = new Map<MetricKey, string | null>()
  /** Explicit user override of which device owns a metric. */
  private preferred = new Map<MetricKey, string>()
  private wheelCircumferenceM = 2.096
  /** True while a session is recording, which is when sensors are chased hardest. */
  private recording = false
  /**
   * Captures raw notification bytes when it is running. Off by default: it is a
   * debugging and reverse-engineering tool, not part of a recording.
   */
  readonly trace = new TraceRecorder()
  /**
   * Beat intervals as they arrive, kept for a few minutes so a rolling HRV
   * window has something to work on. Bounded by time rather than by count,
   * because the arrival rate is the athlete's heart rate.
   */
  private rrHistory: { at: number; ms: number[] }[] = []

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
    this.onPreferencesChanged?.(this.preferences)
    this.emit()
  }

  /**
   * Told when the operator's source assignments change, so they can be kept.
   *
   * Re-deciding which strap owns heart rate at the start of every test day is
   * exactly the kind of setup that gets skipped once and then produces a trace
   * from the wrong device.
   */
  onPreferencesChanged?: (preferences: Record<string, string>) => void

  get preferences(): Record<string, string> {
    return Object.fromEntries(this.preferred)
  }

  /** Restores assignments saved from a previous run. */
  restorePreferences(preferences: Record<string, string>): void {
    this.preferred = new Map(Object.entries(preferences) as [MetricKey, string][])
    this.emit()
  }

  /**
   * Devices worth offering to reconnect next time.
   *
   * Only the identity and the role are kept. Web Bluetooth will not reconnect
   * from an id alone without the permission the browser already holds, so this
   * is an offer to the operator rather than something that happens silently.
   */
  get knownDevices(): { id: string; name: string; profileKey: string }[] {
    return [...this.entries.values()]
      .filter((entry) => entry.profile)
      .map((entry) => ({
        id: entry.device.id,
        name: entry.device.name,
        profileKey: entry.profile!.key,
      }))
  }

  /**
   * Reconnects devices the browser has already been granted access to.
   *
   * `getDevices` returns exactly those, so nothing here can pair something new
   * or reach a device the operator has not already approved.
   */
  async reconnectKnown(saved: { id: string; profileKey: string }[]): Promise<number> {
    if (!navigator.bluetooth?.getDevices) return 0
    let reconnected = 0
    let granted: BluetoothDevice[] = []
    try {
      granted = await navigator.bluetooth.getDevices()
    } catch {
      return 0
    }

    for (const entry of saved) {
      if (this.entries.has(entry.id)) continue
      const device = granted.find((d) => d.id === entry.id)
      const profile = SENSOR_PROFILES.find((p) => p.key === entry.profileKey)
      if (!device || !profile) continue

      const sensor: SensorDevice = {
        id: entry.id,
        name: device.name ?? profile.label,
        kind: profile.kind,
        provides: profile.provides,
        state: 'connecting',
        disconnect: () => this.entries.get(entry.id)?.gattDevice?.gatt?.disconnect(),
      }
      const held: Entry = { device: sensor, values: new Map(), gattDevice: device, profile }
      this.entries.set(entry.id, held)
      device.addEventListener('gattserverdisconnected', () => {
        held.ftms?.forgetControl()
        sensor.state = 'reconnecting'
        this.emit()
        void this.reconnect(held, profile)
      })

      try {
        await this.openSession(held, profile)
        sensor.state = 'connected'
        reconnected += 1
      } catch {
        // Out of range or switched off. Left in the list as reconnecting, so
        // the normal backoff picks it up rather than it vanishing silently.
        sensor.state = 'reconnecting'
        void this.reconnect(held, profile)
      }
      this.emit()
    }
    return reconnected
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
      if (entry && held && now - held.at < staleAfterMs(metric)) return entry.device
    }

    const order = KIND_PRIORITY[metric]
    let best: { device: SensorDevice; rank: number } | null = null
    for (const entry of this.entries.values()) {
      const held = entry.values.get(metric)
      if (!held || now - held.at >= staleAfterMs(metric)) continue
      const rank = order.indexOf(entry.device.kind)
      const effective = rank === -1 ? order.length : rank
      if (!best || effective < best.rank) best = { device: entry.device, rank: effective }
    }
    return best?.device ?? null
  }

  /**
   * Registers interest in which device currently owns a metric.
   *
   * Arbitration can switch mid-test, when a chest strap drops and a trainer's
   * own heart rate estimate takes over. The numbers keep arriving and nothing
   * about the trace says the source changed, which is exactly the kind of thing
   * that is impossible to reconstruct afterwards. Listeners are told so it can
   * be recorded.
   */
  onSourceChange(fn: SourceChangeListener): () => void {
    this.sourceListeners.add(fn)
    return () => this.sourceListeners.delete(fn)
  }

  /** Merged live snapshot across all connected sensors. */
  read(now = Date.now()): MetricUpdate {
    const out: MetricUpdate = {}
    const changes: SourceChange[] = []
    for (const metric of Object.keys(KIND_PRIORITY) as MetricKey[]) {
      const device = this.sourceFor(metric, now)
      const previous = this.lastSources.get(metric) ?? null
      const currentId = device?.id ?? null
      if (currentId !== previous) {
        this.lastSources.set(metric, currentId)
        // The very first resolution of a metric is a change from nothing, and
        // is worth recording too: it says when a sensor started contributing.
        changes.push({ metric, from: previous, to: currentId, toName: device?.name ?? null })
      }
      if (!device) continue
      const held = this.entries.get(device.id)?.values.get(metric)
      if (held) out[metric] = held.value
    }
    if (changes.length) {
      for (const fn of this.sourceListeners) fn(changes)
    }
    const hrEntry = this.sourceFor('heartRate', now)
    const rr = hrEntry ? this.entries.get(hrEntry.id)?.rrIntervalsMs : undefined
    if (rr?.length) out.rrIntervalsMs = rr

    // Both power traces, kept apart. Absent when only one device is reporting,
    // which is the honest state rather than a column of repeats.
    const machinePower = this.powerPair(now).machine
    if (machinePower) out.powerSecondaryW = machinePower.watts

    return out
  }

  /**
   * Beat intervals from the last `seconds`, oldest first.
   *
   * Kept here rather than on the runner because they arrive per beat from a
   * sensor, not per second from the protocol clock.
   */
  recentRr(seconds: number, now = Date.now()): number[] {
    const cutoff = now - seconds * 1000
    const out: number[] = []
    for (const entry of this.rrHistory) {
      if (entry.at >= cutoff) out.push(...entry.ms)
    }
    return out
  }

  /**
   * The two power sources, told apart by the job each is doing.
   *
   * `reference` is whichever device won `power` under the arbitration above,
   * which already prefers a real power meter over a trainer's own estimate.
   * `machine` is the controllable device's own reading, and it is only reported
   * when it is a *different* device: a trainer compared with itself agrees
   * perfectly and says nothing.
   *
   * This split is what the whole correction rests on. One power trace cannot
   * show its own error, and the error is not a constant — a trainer's estimate
   * climbs as the unit warms, which in ERG means the athlete is quietly given
   * less work while every label still says the target.
   */
  powerPair(now = Date.now()): {
    reference: { id: string; name: string; watts: number } | null
    machine: { id: string; name: string; watts: number } | null
  } {
    const referenceDevice = this.sourceFor('power', now)
    const reference = referenceDevice
      ? this.reading(referenceDevice, 'power', now)
      : null

    let machine: { id: string; name: string; watts: number } | null = null
    for (const entry of this.entries.values()) {
      if (!entry.device.control) continue
      if (referenceDevice && entry.device.id === referenceDevice.id) continue
      const held = this.reading(entry.device, 'power', now)
      if (held) {
        machine = held
        break
      }
    }
    return { reference, machine }
  }

  private reading(
    device: SensorDevice,
    metric: MetricKey,
    now: number,
  ): { id: string; name: string; watts: number } | null {
    const held = this.entries.get(device.id)?.values.get(metric)
    if (!held || now - held.at >= staleAfterMs(metric)) return null
    return { id: device.id, name: device.name, watts: held.value }
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
        const intervals = value as number[]
        entry.rrIntervalsMs = intervals
        if (intervals.length) {
          this.rrHistory.push({ at: now, ms: intervals })
          const cutoff = now - RR_HISTORY_MS
          while (this.rrHistory.length && this.rrHistory[0].at < cutoff) this.rrHistory.shift()
        }
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

    const entry: Entry = { device: sensor, values: new Map(), gattDevice: device, profile }
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

  /**
   * Connects to a device with no known profile and subscribes to everything it
   * will notify on, recording the bytes.
   *
   * This is how a parser gets written for hardware whose protocol is not
   * published. It cannot be written from a specification, because there is not
   * one; it has to be reversed from a capture taken while the device was doing
   * something known. Nothing is decoded and nothing reaches the metric stream:
   * inventing an interpretation of bytes nobody has decoded would be worse than
   * having no reading at all.
   *
   * `serviceUuid` has to be supplied by whoever is doing the reversing, since
   * Web Bluetooth will not enumerate services that were not asked for.
   */
  async captureUnknown(serviceUuid: string, label = 'Unknown device'): Promise<SensorDevice> {
    if (!isWebBluetoothAvailable()) {
      throw new Error('Web Bluetooth is not available in this browser.')
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [serviceUuid] }],
      optionalServices: [serviceUuid, SVC.battery, SVC.deviceInformation],
    })

    const id = device.id || `capture:${device.name ?? label}`
    const sensor: SensorDevice = {
      id,
      name: device.name ?? label,
      kind: 'mock',
      provides: [],
      state: 'connecting',
      disconnect: () => this.entries.get(id)?.gattDevice?.gatt?.disconnect(),
    }
    const entry: Entry = { device: sensor, values: new Map(), gattDevice: device }
    this.entries.set(id, entry)
    this.emit()

    try {
      const server = await device.gatt!.connect()
      const service = await server.getPrimaryService(serviceUuid)
      const characteristics = await service.getCharacteristics()

      let subscribed = 0
      for (const chr of characteristics) {
        if (!chr.properties.notify && !chr.properties.indicate) continue
        chr.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value
          if (!value) return
          // Captured, never interpreted.
          this.trace.capture(id, sensor.name, chr.uuid, value)
        })
        try {
          await chr.startNotifications()
          subscribed += 1
        } catch {
          // Some characteristics advertise notify and then refuse it.
        }
      }

      if (subscribed === 0) {
        throw new Error('That service exposes nothing that notifies, so there is nothing to capture.')
      }
    } catch (error) {
      this.remove(id)
      throw error
    }

    sensor.state = 'connected'
    this.emit()
    if (!this.trace.isRecording) this.trace.start()
    return sensor
  }
  /**
   * Reconnects with capped backoff.
   *
   * Never gives up while a session is recording. A strap that drops out at
   * minute five of a forty-five minute test used to be gone for the rest of it,
   * because the attempts ran out long before the test did. Outside a recording
   * the attempts are bounded, so a device left switched off does not have
   * something retrying at it all day.
   */
  private async reconnect(entry: Entry, profile: SensorProfile): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (!this.entries.has(entry.device.id)) return
      if (attempt >= IDLE_RECONNECT_ATTEMPTS && !this.recording) break
      entry.reconnectAttempts = attempt + 1
      await delay(Math.min(1000 * 2 ** Math.min(attempt, 4), MAX_BACKOFF_MS))
      if (!this.entries.has(entry.device.id)) return
      try {
        await this.openSession(entry, profile)
        entry.device.state = 'connected'
        entry.reconnectAttempts = 0
        this.emit()
        return
      } catch {
        // Device still out of range; keep trying.
        this.emit()
      }
    }
    entry.device.state = 'disconnected'
    this.emit()
  }

  /**
   * Told by the app whether a session is being recorded, which is the only
   * thing that decides how hard a dropped sensor is chased.
   */
  setRecording(recording: boolean): void {
    this.recording = recording
    if (!recording) return
    // Anything that gave up while idle gets another run at it now that a test
    // has started, which is exactly when the operator needs it back.
    for (const entry of this.entries.values()) {
      if (entry.device.state !== 'disconnected' || !entry.profile) continue
      entry.device.state = 'reconnecting'
      void this.reconnect(entry, entry.profile)
    }
    this.emit()
  }

  /** Manual retry, for the button in the sensor panel. */
  retry(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (!entry?.profile || entry.device.state === 'connected') return
    entry.device.state = 'reconnecting'
    entry.reconnectAttempts = 0
    this.emit()
    void this.reconnect(entry, entry.profile)
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

      case 'core':
        if (!(await this.notify(entry, service, CORE_CHR.measurement, parseCoreTemperature))) {
          throw new Error('CORE sensor exposes no temperature measurement')
        }
        break

      case 'ftms':
        await this.openFtms(entry, service)
        break

      case 'aranet': {
        // Notify where the firmware offers it, and fall back to polling on the
        // device's own measurement interval. Polling is not a workaround here:
        // this device genuinely has nothing new to say between measurements.
        const notified = await this.notify(
          entry,
          service,
          ARANET_CHR.currentReadings,
          parseAranet,
        )
        if (!notified) await this.pollAranet(entry, service)
        break
      }
    }

    void this.readBattery(entry, server)
  }

  /**
   * Reads the Aranet on its own schedule.
   *
   * The interval characteristic says how often the device measures; anything
   * more often than that is asking a question whose answer cannot have changed.
   * Falls back to five minutes, which is the device's default.
   */
  private async pollAranet(entry: Entry, service: BluetoothRemoteGATTService): Promise<void> {
    const readings = await service.getCharacteristic(ARANET_CHR.currentReadings)

    let intervalS = 300
    try {
      const chr = await service.getCharacteristic(ARANET_CHR.interval)
      const value = (await chr.readValue()).getUint16(0, true)
      if (value > 0 && value <= 3600) intervalS = value
    } catch {
      // Not every firmware exposes it. The default is close enough.
    }

    const read = async () => {
      if (!this.entries.has(entry.device.id)) return
      try {
        this.ingest(entry.device.id, parseAranet(await readings.readValue()))
      } catch {
        // A failed read is not worth interrupting a test for; the next one
        // is only a few minutes away and the value is already marked stale.
      }
    }

    await read()
    const timer = setInterval(() => void read(), intervalS * 1000)
    entry.pollTimer = timer
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
    uuid: number | string,
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
      let decoded: MetricUpdate | undefined
      try {
        decoded = parse(value)
        this.ingest(entry.device.id, decoded)
      } catch {
        // A malformed packet must not tear down the notification stream.
      }
      // Captured after parsing and outside the try, so a packet that broke the
      // parser is still kept: that is the one worth having.
      this.trace.capture(entry.device.id, entry.device.name, String(uuid), value, decoded)
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
    if (entry.pollTimer) clearInterval(entry.pollTimer)
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
