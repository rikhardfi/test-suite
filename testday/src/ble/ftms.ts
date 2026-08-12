import { CHR, FTMS_OP, FTMS_RESULT } from './uuids'
import { parseFtmsFeatures, parsePowerRange, parseSpeedRange, type FtmsFeatures } from './parse'
import type { MachineControl } from './types'

const CONTROL_TIMEOUT_MS = 4000

/**
 * Fitness Machine Control Point client.
 *
 * The control point is strictly one command at a time: a write must be matched
 * by an indication carrying the response before the next write is issued, or
 * trainers start dropping commands. Requests are therefore serialised through
 * a promise chain.
 */
export class FtmsControl implements MachineControl {
  private queue: Promise<unknown> = Promise.resolve()
  private pending: { opCode: number; resolve: () => void; reject: (e: Error) => void } | null = null
  private hasControl = false

  readonly canSetPower: boolean
  readonly canSetSpeed: boolean
  readonly canSetIncline: boolean

  constructor(
    private readonly controlPoint: BluetoothRemoteGATTCharacteristic,
    readonly features: FtmsFeatures,
    readonly powerRange?: { min: number; max: number; step: number },
    readonly speedRange?: { min: number; max: number; step: number },
  ) {
    this.canSetPower = features.setPower
    this.canSetSpeed = features.setSpeed
    this.canSetIncline = features.setIncline
    controlPoint.addEventListener('characteristicvaluechanged', this.onIndication)
  }

  private onIndication = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value || value.byteLength < 3) return
    if (value.getUint8(0) !== FTMS_OP.responseCode) return

    const requestOp = value.getUint8(1)
    const result = value.getUint8(2)
    const pending = this.pending
    if (!pending || pending.opCode !== requestOp) return

    this.pending = null
    if (result === 0x01) pending.resolve()
    else pending.reject(new Error(`FTMS ${labelFor(requestOp)}: ${FTMS_RESULT[result] ?? `error 0x${result.toString(16)}`}`))
  }

  /** Serialises one write + its indication, so commands cannot interleave. */
  private send(opCode: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    const run = async () => {
      const frame = new Uint8Array(1 + payload.length)
      frame[0] = opCode
      frame.set(payload, 1)

      const answered = new Promise<void>((resolve, reject) => {
        this.pending = { opCode, resolve, reject }
        setTimeout(() => {
          if (this.pending?.opCode === opCode) {
            this.pending = null
            reject(new Error(`FTMS ${labelFor(opCode)}: no response from machine`))
          }
        }, CONTROL_TIMEOUT_MS)
      })

      await this.controlPoint.writeValueWithResponse(frame as BufferSource)
      await answered
    }

    // Keep the chain alive even when one command fails.
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  async requestControl(): Promise<void> {
    await this.send(FTMS_OP.requestControl)
    this.hasControl = true
  }

  /** Takes control lazily so callers do not have to sequence it themselves. */
  private async ensureControl(): Promise<void> {
    if (!this.hasControl) await this.requestControl()
  }

  async setTargetPower(watts: number): Promise<void> {
    await this.ensureControl()
    const clamped = clamp(Math.round(watts), this.powerRange?.min ?? 0, this.powerRange?.max ?? 2000)
    const payload = new Uint8Array(2)
    new DataView(payload.buffer).setInt16(0, clamped, true)
    await this.send(FTMS_OP.setTargetPower, payload)
  }

  async setTargetSpeedKph(kph: number): Promise<void> {
    await this.ensureControl()
    const clamped = clamp(kph, this.speedRange?.min ?? 0, this.speedRange?.max ?? 40)
    const payload = new Uint8Array(2)
    new DataView(payload.buffer).setUint16(0, Math.round(clamped * 100), true)
    await this.send(FTMS_OP.setTargetSpeed, payload)
  }

  async setTargetInclinePct(pct: number): Promise<void> {
    await this.ensureControl()
    const payload = new Uint8Array(2)
    new DataView(payload.buffer).setInt16(0, Math.round(pct * 10), true)
    await this.send(FTMS_OP.setTargetInclination, payload)
  }

  async start(): Promise<void> {
    await this.ensureControl()
    await this.send(FTMS_OP.startOrResume)
  }

  async stop(): Promise<void> {
    if (!this.hasControl) return
    await this.send(FTMS_OP.stopOrPause, new Uint8Array([0x01]))
    this.hasControl = false
  }

  /** Called on disconnect: the machine drops the control session anyway. */
  forgetControl(): void {
    this.hasControl = false
    this.pending = null
  }
}

function labelFor(opCode: number): string {
  const entry = Object.entries(FTMS_OP).find(([, v]) => v === opCode)
  return entry ? entry[0] : `op 0x${opCode.toString(16)}`
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** Reads the optional descriptive characteristics, tolerating missing ones. */
export async function readFtmsCapabilities(service: BluetoothRemoteGATTService): Promise<{
  features: FtmsFeatures
  powerRange?: { min: number; max: number; step: number }
  speedRange?: { min: number; max: number; step: number }
}> {
  const features = await readOptional(service, CHR.fitnessMachineFeature, parseFtmsFeatures)
  const powerRange = await readOptional(service, CHR.supportedPowerRange, parsePowerRange)
  const speedRange = await readOptional(service, CHR.supportedSpeedRange, parseSpeedRange)

  return {
    // A machine that does not publish its feature bits is assumed capable;
    // an unsupported command then fails loudly at the control point instead.
    features: features ?? {
      cadence: true,
      powerMeasurement: true,
      inclination: false,
      setSpeed: true,
      setIncline: true,
      setResistance: true,
      setPower: true,
    },
    powerRange,
    speedRange,
  }
}

async function readOptional<T>(
  service: BluetoothRemoteGATTService,
  uuid: number,
  parse: (view: DataView) => T,
): Promise<T | undefined> {
  try {
    const chr = await service.getCharacteristic(uuid)
    return parse(await chr.readValue())
  } catch {
    return undefined
  }
}
