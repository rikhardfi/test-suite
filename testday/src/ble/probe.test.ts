import { describe, expect, it } from 'vitest'
import { describeProbe, runErgProbe } from './probe'
import type { MachineControl } from './types'

/**
 * A trainer on a fake clock.
 *
 * `sleep` advances the clock instead of waiting, so a probe that takes half a
 * minute of wall time runs in microseconds and the timings under test are exact
 * rather than approximate.
 */
function fakeRig(options: {
  /** What the machine's own reading settles at, given what it was told. */
  machineFor?: (commanded: number) => number
  /** Reference over machine: a drivetrain plus whatever they disagree by. */
  ratio?: number
  /** Seconds the machine takes to arrive at its set-point. */
  riseS?: number
  canSetPower?: boolean
  refuseControl?: boolean
  rejectTarget?: boolean
  /** No separate meter: the caller reports one source only. */
  singleSource?: boolean
}) {
  const {
    machineFor = (c) => c,
    ratio = 1,
    riseS = 2,
    canSetPower = true,
    refuseControl = false,
    rejectTarget = false,
    singleSource = false,
  } = options

  let clock = 0
  let commanded = 0
  let commandedAt = 0
  const commands: number[] = []

  const control: MachineControl = {
    canSetPower,
    canSetSpeed: false,
    canSetIncline: false,
    requestControl: async () => {
      if (refuseControl) throw new Error('control point busy')
    },
    setTargetPower: async (watts) => {
      if (rejectTarget) throw new Error('out of range')
      commanded = watts
      commandedAt = clock
      commands.push(watts)
    },
    setTargetSpeedKph: async () => undefined,
    setTargetInclinePct: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  }

  const read = () => {
    const settled = machineFor(commanded)
    const progress = riseS <= 0 ? 1 : Math.min(1, (clock - commandedAt) / riseS)
    const machineW = settled * progress
    if (singleSource) return { referenceW: machineW }
    return { referenceW: machineW * ratio, machineW }
  }

  return {
    control,
    read,
    commands,
    sleep: async (ms: number) => {
      clock += ms / 1000
    },
    now: () => clock * 1000,
  }
}

describe('runErgProbe', () => {
  it('measures the multiplier that makes the pedals read the target', async () => {
    // The pedals read 4.9% above the trainer, as on 14 August 2026.
    const rig = fakeRig({ ratio: 1.049 })
    const probe = await runErgProbe(rig)

    expect(probe.ok).toBe(true)
    expect(probe.hasReference).toBe(true)
    expect(probe.multiplier).toBeCloseTo(1 / 1.049, 3)
    // Commanding 190.7 W puts 200 W through the pedals.
    expect(200 * probe.multiplier!).toBeCloseTo(190.7, 0)
    expect(rig.commands).toEqual([100, 180])
  })

  it('reports how long the machine took to arrive', async () => {
    const rig = fakeRig({ riseS: 4 })
    const probe = await runErgProbe(rig)
    for (const setpoint of probe.setpoints) {
      expect(setpoint.timeTo90PctS).not.toBeNull()
      expect(setpoint.timeTo90PctS!).toBeGreaterThan(3)
      expect(setpoint.timeTo90PctS!).toBeLessThan(5)
    }
  })

  it('fails when the machine acknowledges a target and never reaches it', async () => {
    // The silent ERG failure: every command accepted, no power arrives.
    const rig = fakeRig({ machineFor: () => 40 })
    const probe = await runErgProbe(rig)

    expect(probe.ok).toBe(false)
    expect(probe.failure).toContain('never got within 10%')
    expect(probe.setpoints[0].timeTo90PctS).toBeNull()
  })

  it('fails when the machine settles well away from what it was told', async () => {
    // Reaches the set-point and then sits 15% above it, which is a machine
    // that is responding and lying rather than one that is not responding.
    const rig = fakeRig({ machineFor: (c) => c * 1.15 })
    const probe = await runErgProbe(rig)
    expect(probe.ok).toBe(false)
    expect(probe.setpoints[0].timeTo90PctS).not.toBeNull()
    expect(probe.failure).toContain('% out')
  })

  it('still answers the response question with only one power source', async () => {
    const rig = fakeRig({ singleSource: true })
    const probe = await runErgProbe(rig)

    expect(probe.ok).toBe(true)
    expect(probe.hasReference).toBe(false)
    // No second source, so no correction can be measured. Null, never 1.
    expect(probe.multiplier).toBeNull()
    expect(describeProbe(probe)).toContain('No second power source')
  })

  it('reports a machine that will not give up control', async () => {
    const rig = fakeRig({ refuseControl: true })
    const probe = await runErgProbe(rig)
    expect(probe.ok).toBe(false)
    expect(probe.failure).toContain('refused control')
    expect(rig.commands).toEqual([])
  })

  it('reports a machine that cannot take a power target at all', async () => {
    const rig = fakeRig({ canSetPower: false })
    const probe = await runErgProbe(rig)
    expect(probe.ok).toBe(false)
    expect(probe.failure).toContain('does not accept power targets')
  })

  it('carries on through a rejected set-point and reports it', async () => {
    const rig = fakeRig({ rejectTarget: true })
    const probe = await runErgProbe(rig)
    expect(probe.ok).toBe(false)
    expect(probe.failure).toContain('rejected')
    expect(probe.setpoints).toHaveLength(2)
  })

  it('says which way the correction goes, in words', async () => {
    const rig = fakeRig({ ratio: 1.05 })
    const probe = await runErgProbe(rig)
    const text = describeProbe(probe)
    expect(text).toContain('above')
    expect(text).toContain('lower')
  })
})
