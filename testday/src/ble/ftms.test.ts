import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FtmsControl, explainControlError } from './ftms'
import { FTMS_OP } from './uuids'

const FEATURES = {
  cadence: true,
  powerMeasurement: true,
  inclination: false,
  setSpeed: false,
  setIncline: false,
  setResistance: true,
  setPower: true,
}

/** A control point that answers, stays silent, or never returns the write. */
class FakeControlPoint extends EventTarget {
  value: DataView | null = null
  writes: number[][] = []
  mode: 'answer' | 'silent' | 'hang' = 'answer'
  result = 0x01

  writeValueWithResponse(frame: BufferSource): Promise<void> {
    const bytes = Array.from(new Uint8Array(frame as ArrayBuffer))
    this.writes.push(bytes)
    if (this.mode === 'hang') return new Promise(() => undefined)
    if (this.mode === 'answer') this.indicate(bytes[0], this.result)
    return Promise.resolve()
  }

  indicate(opCode: number, result: number): void {
    queueMicrotask(() => {
      this.value = new DataView(new Uint8Array([FTMS_OP.responseCode, opCode, result]).buffer)
      this.dispatchEvent(new Event('characteristicvaluechanged'))
    })
  }
}

function make() {
  const point = new FakeControlPoint()
  const control = new FtmsControl(point as unknown as BluetoothRemoteGATTCharacteristic, FEATURES)
  return { point, control }
}

describe('FtmsControl', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('takes control once, then sends the target', async () => {
    const { point, control } = make()
    await control.setTargetPower(200)
    await control.setTargetPower(210)
    expect(point.writes.map((w) => w[0])).toEqual([
      FTMS_OP.requestControl,
      FTMS_OP.setTargetPower,
      FTMS_OP.setTargetPower,
    ])
  })

  it('does not let an answered command’s timer clear a later command', async () => {
    const { point, control } = make()
    await control.setTargetPower(200)

    // The second command is in flight at the moment the first one's timer
    // would have fired. It used to lose its pending slot and wait forever.
    await vi.advanceTimersByTimeAsync(3990)
    point.mode = 'silent'
    const second = control.setTargetPower(210)
    await vi.advanceTimersByTimeAsync(20)
    point.indicate(FTMS_OP.setTargetPower, 0x01)
    await expect(second).resolves.toBeUndefined()
  })

  it('times out a write that never returns, and carries on afterwards', async () => {
    const { point, control } = make()
    await control.setTargetPower(200)

    point.mode = 'hang'
    const stuck = control.setTargetPower(210)
    const outcome = expect(stuck).rejects.toThrow(/no response/)
    await vi.advanceTimersByTimeAsync(4000)
    await outcome

    point.mode = 'answer'
    await expect(control.setTargetPower(220)).resolves.toBeUndefined()
  })

  it('rejects the command in flight when the machine disconnects', async () => {
    const { point, control } = make()
    await control.setTargetPower(200)

    point.mode = 'silent'
    const inFlight = control.setTargetPower(210)
    const outcome = expect(inFlight).rejects.toThrow(/disconnected/)
    await vi.advanceTimersByTimeAsync(10)
    control.forgetControl()
    await outcome

    // Control was dropped with the link, so it is requested again.
    point.mode = 'answer'
    await control.setTargetPower(220)
    expect(point.writes.slice(-2).map((w) => w[0])).toEqual([
      FTMS_OP.requestControl,
      FTMS_OP.setTargetPower,
    ])
  })

  it('asks for control again after the machine says it is not permitted', async () => {
    const { point, control } = make()
    await control.setTargetPower(200)

    point.result = 0x05
    const refused = control.setTargetPower(210)
    await expect(refused).rejects.toThrow(/not permitted/)
    const message = await refused.then(() => '', (e: Error) => e.message)
    expect(explainControlError(message)).toMatch(/Another application/)
    expect(explainControlError('FTMS setTargetPower: no response from machine')).toMatch(/no response/)

    point.result = 0x01
    await control.setTargetPower(220)
    expect(point.writes.slice(-2).map((w) => w[0])).toEqual([
      FTMS_OP.requestControl,
      FTMS_OP.setTargetPower,
    ])
  })
})
