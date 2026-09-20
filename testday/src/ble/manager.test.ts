import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSOR_PROFILES, SensorManager } from './manager'
import { CHR, ESS_CHR, SVC } from './uuids'

/**
 * A radio that behaves like the one a crank power meter is on.
 *
 * The cases worth reproducing are not "the device went away". They are the ones
 * a Quarq produces on a real test day: it drops several times a minute once the
 * rider is working, because the antenna spends part of every revolution behind
 * a leg; the drops arrive faster than a reconnection completes; and a link
 * sometimes comes back half open, connected as far as the browser is concerned
 * with an attribute cache that no longer resolves.
 *
 * `peakConcurrent` is the measurement the first of those rests on. Chrome
 * serialises GATT operations per device and fails overlapping connects, so a
 * reconnect scheme that starts a loop per drop gets slower the more the device
 * drops. It must never exceed one.
 */
class FakeCharacteristic extends EventTarget {
  value: DataView | null = null
  notifying = false
  reads = 0
  readonly properties = { notify: true, indicate: false }

  constructor(
    readonly uuid: string,
    private readonly bytes: number[] = [0, 0, 0, 0],
  ) {
    super()
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    this.notifying = true
    return this
  }

  async readValue(): Promise<DataView> {
    this.reads += 1
    return new DataView(new Uint8Array(this.bytes).buffer)
  }

  /** The device sends a packet. */
  send(bytes: number[]): void {
    this.value = new DataView(new Uint8Array(bytes).buffer)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

class FakeService {
  constructor(
    readonly uuid: number | string,
    private readonly characteristics: Map<number | string, FakeCharacteristic>,
  ) {}

  async getCharacteristic(uuid: number | string): Promise<FakeCharacteristic> {
    const chr = this.characteristics.get(uuid)
    if (!chr) throw new Error(`No characteristic ${uuid}`)
    return chr
  }

  async getCharacteristics(): Promise<FakeCharacteristic[]> {
    return [...this.characteristics.values()]
  }
}

class FakeGatt {
  connected = false
  connectCalls = 0
  /** Connect attempts that should fail before one is allowed to succeed. */
  failConnects = 0
  /** Service lookups that should fail although the link reports connected. */
  failServices = 0
  private concurrent = 0
  peakConcurrent = 0

  constructor(
    private readonly device: FakeDevice,
    private readonly services: Map<number | string, FakeService>,
  ) {}

  async connect(): Promise<FakeGatt> {
    this.connectCalls += 1
    this.concurrent += 1
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent)
    try {
      // Establishing a link takes real time, which is the whole reason two
      // attempts can be in flight at once. Modelling it as instantaneous would
      // hide exactly the overlap these tests are about.
      await new Promise((resolve) => setTimeout(resolve, CONNECT_MS))
      if (this.failConnects > 0) {
        this.failConnects -= 1
        throw new Error('GATT connection failed')
      }
      this.connected = true
      return this
    } finally {
      this.concurrent -= 1
    }
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    // The browser dispatches this out of band, not inside the call.
    queueMicrotask(() => this.device.dispatchEvent(new Event('gattserverdisconnected')))
  }

  /** The link is lost at the device's end, which is what a dropout is. */
  drop(): void {
    this.disconnect()
  }

  async getPrimaryService(uuid: number | string): Promise<FakeService> {
    if (this.failServices > 0) {
      this.failServices -= 1
      // Note that the link stays "connected": this is the half-open case.
      throw new Error('Service discovery failed')
    }
    if (!this.connected) throw new Error('GATT server is disconnected')
    const service = this.services.get(uuid)
    if (!service) throw new Error(`No service ${uuid}`)
    return service
  }
}

class FakeDevice extends EventTarget {
  readonly gatt: FakeGatt

  constructor(
    readonly id: string,
    readonly name: string,
    services: Map<number | string, FakeService>,
  ) {
    super()
    this.gatt = new FakeGatt(this, services)
  }
}

/** A cycling power meter: one measurement characteristic, and nothing else. */
function powerMeter(id = 'quarq-1'): { device: FakeDevice; measurement: FakeCharacteristic } {
  const measurement = new FakeCharacteristic(String(CHR.cyclingPowerMeasurement))
  const services = new Map<number | string, FakeService>([
    [
      SVC.cyclingPower,
      new FakeService(SVC.cyclingPower, new Map([[CHR.cyclingPowerMeasurement, measurement]])),
    ],
  ])
  return { device: new FakeDevice(id, 'Quarq DZero', services), measurement }
}

/** A room sensor, which is polled rather than notified. */
function roomSensor(id = 'ess-1'): { device: FakeDevice; temperature: FakeCharacteristic } {
  const temperature = new FakeCharacteristic(String(ESS_CHR.temperature), [0xdc, 0x08])
  const services = new Map<number | string, FakeService>([
    [
      SVC.environmentalSensing,
      new FakeService(SVC.environmentalSensing, new Map([[ESS_CHR.temperature, temperature]])),
    ],
  ])
  return { device: new FakeDevice(id, 'Room sensor', services), temperature }
}

/** How long the fake radio takes to bring a link up. */
const CONNECT_MS = 150

const profile = (key: string) => SENSOR_PROFILES.find((p) => p.key === key)!

function stubBluetooth(device: FakeDevice): void {
  vi.stubGlobal('navigator', {
    bluetooth: {
      requestDevice: async () => device,
      getDevices: async () => [device],
    },
  })
}

/** A cycling power measurement of `watts`, flags clear. */
const powerPacket = (watts: number) => [0x00, 0x00, watts & 0xff, (watts >> 8) & 0xff]

/** Lets the microtask queue drain without moving the clock. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Pairs a device, carrying the clock over the fake radio's connect time. */
async function pair(manager: SensorManager, key: string) {
  const connecting = manager.connect(profile(key))
  await vi.advanceTimersByTimeAsync(CONNECT_MS)
  return connecting
}

describe('SensorManager reconnection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs one reconnect loop however many times the device drops', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')
    expect(sensor.state).toBe('connected')

    // A rider standing on the pedals: the link goes several times in a row,
    // faster than any one reconnection can complete.
    manager.setRecording(true)
    device.gatt.failConnects = 100
    for (let i = 0; i < 5; i++) {
      device.gatt.connected = true
      device.gatt.drop()
      await settle()
    }

    // Every backoff started during the storm now comes due together. One loop
    // means one attempt; a loop per drop means five of them on one radio, and
    // the browser fails all but one — so the more the meter dropped, the less
    // likely it was ever to come back.
    await vi.advanceTimersByTimeAsync(1000)
    expect(device.gatt.peakConcurrent).toBe(1)

    device.gatt.failConnects = 0
    await vi.advanceTimersByTimeAsync(10000)
    expect(sensor.state).toBe('connected')
    expect(device.gatt.peakConcurrent).toBe(1)
    manager.removeAll()
  })

  it('counts every dropout, so a flaky meter is visible', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    manager.setRecording(true)
    for (let i = 0; i < 3; i++) {
      device.gatt.drop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(sensor.state).toBe('connected')
    }

    expect(sensor.drops).toBe(3)
    manager.removeAll()
  })

  it('does not subscribe twice when a session is reopened', async () => {
    const { device, measurement } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    await pair(manager, 'power')

    const seen: number[] = []
    manager.onMetric((_id, update) => {
      if (update.power != null) seen.push(update.power)
    })

    manager.setRecording(true)
    for (let i = 0; i < 3; i++) {
      device.gatt.drop()
      await vi.advanceTimersByTimeAsync(5000)
    }

    // The browser hands back the same characteristic object for a device it
    // already knows, so a reconnection that subscribed again without dropping
    // the old handler would report this packet once per reconnection.
    measurement.send(powerPacket(250))
    expect(seen).toEqual([250])
    manager.removeAll()
  })

  it('drops a half-open link rather than retrying down it for ever', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    manager.setRecording(true)
    // Service discovery fails once while the link still claims to be up: the
    // shape a reconnection takes when the attribute cache has gone stale.
    device.gatt.failServices = 1
    device.gatt.drop()
    await settle()
    device.gatt.connected = true

    await vi.advanceTimersByTimeAsync(10000)

    expect(sensor.state).toBe('connected')
    // Two links: the one that came back half open, and the fresh one built
    // after it was thrown away.
    expect(device.gatt.connectCalls).toBeGreaterThanOrEqual(2)
    manager.removeAll()
  })

  it('chases a dropped sensor harder while a session is recording', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    manager.setRecording(true)
    device.gatt.failConnects = 6
    device.gatt.drop()
    await settle()

    // Six failed attempts inside twenty seconds needs the recording ceiling;
    // on the idle one the fifth attempt alone would still be waiting.
    await vi.advanceTimersByTimeAsync(20000)
    expect(sensor.state).toBe('connected')
    manager.removeAll()
  })

  it('gives up when idle, and comes back when a test starts', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    device.gatt.failConnects = 1000
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(sensor.state).toBe('disconnected')

    // The operator switches the meter back on and starts the test.
    device.gatt.failConnects = 0
    manager.setRecording(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sensor.state).toBe('connected')
    manager.removeAll()
  })

  it('lets a retry cut the backoff short while it is reconnecting', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    device.gatt.failConnects = 4
    device.gatt.drop()
    // Far enough in that the idle backoff is sitting on its long wait.
    await vi.advanceTimersByTimeAsync(20000)
    expect(sensor.state).toBe('reconnecting')
    const before = device.gatt.connectCalls

    device.gatt.failConnects = 0
    manager.retry(sensor.id)
    await vi.advanceTimersByTimeAsync(1100)

    expect(device.gatt.connectCalls).toBeGreaterThan(before)
    expect(sensor.state).toBe('connected')
    manager.removeAll()
  })

  it('does not stack a poll timer on every reconnection', async () => {
    const { device, temperature } = roomSensor()
    stubBluetooth(device)
    const manager = new SensorManager()
    await pair(manager, 'ess')
    expect(temperature.reads).toBe(1)

    manager.setRecording(true)
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(5000)
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(5000)

    // Three connections have each read once on opening. One minute on, a
    // sensor being polled by one timer reads once more, not three times.
    const opened = temperature.reads
    expect(opened).toBe(3)
    await vi.advanceTimersByTimeAsync(60000)
    expect(temperature.reads).toBe(opened + 1)
    manager.removeAll()
  })

  it('reuses the entry when a known device is paired again', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    device.gatt.failConnects = 1000
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(sensor.state).toBe('reconnecting')

    // Operator loses patience and pairs it from the chooser again. The entry
    // is the one already in the list, and the attempt joins the loop that is
    // already chasing the device rather than opening a second one beside it.
    device.gatt.failConnects = 0
    const again = await manager.connect(profile('power'))
    expect(manager.devices).toHaveLength(1)
    expect(again).toBe(sensor)

    await vi.advanceTimersByTimeAsync(1000)
    expect(again.state).toBe('connected')

    // And the entry still has exactly one disconnect handler on it.
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(device.gatt.peakConcurrent).toBe(1)
    manager.removeAll()
  })

  it('leaves a removed device alone when its old handler fires', async () => {
    const { device, measurement } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const first = await pair(manager, 'power')

    manager.remove(first.id)
    // The browser keeps the handler on the device for the life of the page, so
    // pairing again and then dropping wakes the old entry's handler too.
    const second = await pair(manager, 'power')
    expect(second).not.toBe(first)

    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(3000)

    expect(second.state).toBe('connected')
    expect(first.drops ?? 0).toBe(0)
    expect(device.gatt.peakConcurrent).toBe(1)

    const seen: number[] = []
    manager.onMetric((_id, update) => {
      if (update.power != null) seen.push(update.power)
    })
    measurement.send(powerPacket(190))
    expect(seen).toEqual([190])
    manager.removeAll()
  })

  it('stops chasing a device the operator removed', async () => {
    const { device } = powerMeter()
    stubBluetooth(device)
    const manager = new SensorManager()
    const sensor = await pair(manager, 'power')

    manager.setRecording(true)
    device.gatt.failConnects = 1000
    device.gatt.drop()
    await vi.advanceTimersByTimeAsync(3000)

    manager.remove(sensor.id)
    const calls = device.gatt.connectCalls
    await vi.advanceTimersByTimeAsync(30000)
    expect(device.gatt.connectCalls).toBe(calls)
  })
})
